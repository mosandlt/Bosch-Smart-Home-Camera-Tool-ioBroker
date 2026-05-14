/**
 * Unit tests for src/main.ts — adapter lifecycle + v0.2.0 command handlers
 *
 * Tests cover:
 *
 *   Lifecycle (PKCE browser flow):
 *   1. redirect_url pasted → code extracted → token exchange → info.connection=true
 *   2. Valid tokens stored → skip login, arm refresh-loop directly
 *   3. onUnload → refresh-timeout cleared, info.connection=false
 *   4. No tokens + no redirect_url → show login URL, info.connection=false, no crash
 *   5. redirect_url paste with bad code → login failure, info.connection=false, no crash
 *   10. redirect_url paste but no stored PKCE verifier → error, no crash
 *   11. No tokens + no redirect_url but existing stored PKCE verifier → reuses verifier
 *
 *   v0.2.0 / v0.3.0 command handlers:
 *   6. handlePrivacyToggle → Cloud-API PUT /v11/.../privacy, no RCP+ (gen2 returns 401)
 *   7. handleSnapshotTrigger → calls openLiveSession + fetchSnapshot + writeFileAsync + snapshot_path
 *   8. FCM start throws FcmCbsRegistrationError → info.fcm_active=error, no crash
 *   9. onUnload → stops TLS proxies + FCM listener + closes live sessions
 *   12. handleImageRotationToggle → pure local flag (no Cloud API / no RCP+); state ack'd
 *
 * Strategy:
 *   - Inject @iobroker/adapter-core mock into require.cache before loading build/main.js
 *   - Use mockAdapterCore + MockDatabase so the BoschSmartHomeCamera instance IS
 *     the mock adapter and all setStateAsync/getStateAsync calls hit the in-memory DB.
 *   - Stub missing mock methods (setTimeout, clearTimeout, terminate) inline.
 *   - Read state values directly from database.getState(fullId) — synchronous and reliable.
 *   - Stub network calls with stubAxiosSequence.
 *   - For v0.2.0 tests: inject mock lib modules into require.cache before loading main.js
 *     so that openLiveSession / sendRcpCommand / fetchSnapshot / startTlsProxy are replaced.
 *
 * NOTE: We use require() dynamically (not ES import) so that the mock adapter-core can
 * be injected into require.cache before build/main.js evaluates its imports.
 */

import { expect } from "chai";
import * as sinon from "sinon";
import * as path from "path";

import { stubAxiosSequence, restoreAxios } from "./helpers/axios-mock";

// Type-only imports — not loaded at runtime
import type { MockDatabase } from "@iobroker/testing/build/tests/unit/mocks/mockDatabase";
import type { MockAdapter } from "@iobroker/testing/build/tests/unit/mocks/mockAdapter";

// ── Fixtures ───────────────────────────────────────────────────────────────────

/** Minimal Keycloak token response body */
const TOKEN_BODY = {
    access_token: "acc.tok.fresh",
    refresh_token: "ref.tok.fresh",
    expires_in: 300,
    refresh_expires_in: 86400,
    token_type: "Bearer",
    scope: "email offline_access profile openid",
};

/** Minimal camera list response body */
const CAMERAS_BODY = [
    {
        id: "EF791764-A48D-4F00-9B32-EF04BEB0DDA0",
        title: "Terrasse",
        hardwareVersion: "HOME_Eyes_Outdoor",
        firmwareVersion: "9.40.25",
    },
];

/**
 * Simulated Bosch redirect URL — what the user pastes after browser login.
 * Contains a valid `code` query parameter.
 */
const REDIRECT_URL_WITH_CODE =
    "https://www.bosch.com/boschcam?code=AUTH_CODE_123&state=randomstate123";

/**
 * Redirect URL with an error — simulates failed login or user denied access.
 */
const REDIRECT_URL_WITH_ERROR =
    "https://www.bosch.com/boschcam?error=access_denied&state=randomstate123";

/**
 * Fake PKCE verifier stored from a previous adapter start.
 * Must be >10 chars so the adapter reuses it without regenerating.
 */
const STORED_PKCE_VERIFIER = "fakepkceverifier1234567890abcdefghijklmnopqrstuvwxyz";

// ── Paths ──────────────────────────────────────────────────────────────────────

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const MAIN_JS_PATH = path.join(REPO_ROOT, "build", "main.js");
const ADAPTER_CORE_PATH = require.resolve("@iobroker/adapter-core");

// ── Mock modules (loaded via CommonJS require, not ES import) ─────────────────

// eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
const { MockDatabase: MockDatabaseCtor } =
    require("@iobroker/testing/build/tests/unit/mocks/mockDatabase") as {
        MockDatabase: new () => MockDatabase;
    };

// eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
const { mockAdapterCore: mockAdapterCoreFn } =
    require("@iobroker/testing/build/tests/unit/mocks/mockAdapterCore") as {
        mockAdapterCore: (
            db: MockDatabase,
            opts?: { onAdapterCreated?: (a: MockAdapter) => void },
        ) => unknown;
    };

// ── Adapter factory ────────────────────────────────────────────────────────────

type TestAdapter = MockAdapter & {
    readyHandler?: () => Promise<void>;
    unloadHandler?: (cb: () => void) => void;
    stateChangeHandler?: ioBroker.StateChangeHandler;
};

/**
 * Create a fresh BoschSmartHomeCamera instance wired to a new MockDatabase.
 *
 * The instance IS the MockAdapter (because mockAdapterCore replaces the
 * Adapter base class), so all setState/getState/etc. calls operate on db.
 *
 * Missing mock methods are stubbed inline:
 *   - this.setTimeout   (used in scheduleTokenRefresh)
 *   - this.clearTimeout (used in onUnload)
 *   - this.terminate    (mock version throws; stubbed as no-op so onReady doesn't crash)
 */
function createAdapter(configOverrides: Record<string, unknown> = {}): {
    db: MockDatabase;
    adapter: TestAdapter;
} {
    const db = new MockDatabaseCtor();
    let capturedAdapter: MockAdapter | null = null;

    const core = mockAdapterCoreFn(db, {
        onAdapterCreated: (a: MockAdapter) => {
            capturedAdapter = a;
        },
    });

    // Inject mock core into require.cache BEFORE requiring main.js
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (require.cache as any)[ADAPTER_CORE_PATH] = {
        id: ADAPTER_CORE_PATH,
        filename: ADAPTER_CORE_PATH,
        loaded: true,
        parent: module,
        children: [],
        path: path.dirname(ADAPTER_CORE_PATH),
        paths: [],
        exports: core,
    };

    // Clear main.js so it re-evaluates with the fresh mock core
    delete require.cache[MAIN_JS_PATH];

    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const factory = require(MAIN_JS_PATH) as (opts: Record<string, unknown>) => MockAdapter;
    factory({
        config: {
            redirect_url: "",
            region: "EU",
            ...configOverrides,
        },
    });

    if (!capturedAdapter) {
        throw new Error("mockAdapterCore did not capture the adapter — factory call failed");
    }

    const adapter = capturedAdapter as TestAdapter;

    // Stub methods that the @iobroker/testing mock omits:
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).setTimeout = (_fn: () => void, _ms: number) => null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).clearTimeout = (_handle: unknown) => undefined;
    // The mock's terminate() throws an Error object which propagates from onReady;
    // stub it as no-op so the adapter can call terminate() without crashing the test.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).terminate = (_reason?: string, _exitCode?: number) => undefined;

    return { db, adapter };
}

/**
 * Read a state value synchronously from the MockDatabase.
 * The DB stores states by fully-qualified ID: "<namespace>.<stateId>".
 */
function getStateVal(db: MockDatabase, adapter: TestAdapter, id: string): unknown {
    const fullId = `${adapter.namespace}.${id}`;
    const state = db.getState(fullId);
    return (state as ioBroker.State | null | undefined)?.val;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("main adapter — lifecycle", () => {
    afterEach(() => {
        restoreAxios();
    });

    // ── Test 1: redirect_url pasted → code exchange → connected ───────────────

    it("redirect_url pasted with code: exchanges code for tokens, sets info.connection=true", async () => {
        // HTTP sequence for PKCE paste flow:
        //   1. POST token exchange (code → TokenResult)
        //   2. GET /v11/video_inputs → camera list
        stubAxiosSequence([
            // Step 1: POST token exchange
            {
                status: 200,
                data: TOKEN_BODY,
            },
            // Step 2: GET /v11/video_inputs
            {
                status: 200,
                data: CAMERAS_BODY,
            },
        ]);

        const { db, adapter } = createAdapter({
            redirect_url: REDIRECT_URL_WITH_CODE,
        });

        // Pre-store a PKCE verifier so the adapter can complete the exchange
        db.publishState(`${adapter.namespace}.info.pkce_verifier`, {
            val: STORED_PKCE_VERIFIER,
            ack: true,
        });
        db.publishState(`${adapter.namespace}.info.pkce_state`, {
            val: "randomstate123",
            ack: true,
        });

        await adapter.readyHandler!();

        // info.connection should be true after successful token exchange + camera discovery
        expect(
            getStateVal(db, adapter, "info.connection"),
            "info.connection should be true after redirect_url exchange",
        ).to.equal(true);

        // Access token should be stored
        expect(
            getStateVal(db, adapter, "info.access_token"),
            "info.access_token should be stored after code exchange",
        ).to.equal("acc.tok.fresh");

        // Camera state tree should be created
        expect(
            getStateVal(db, adapter, "cameras.EF791764-A48D-4F00-9B32-EF04BEB0DDA0.name"),
            "camera name state should be set",
        ).to.equal("Terrasse");

        expect(
            getStateVal(db, adapter, "cameras.EF791764-A48D-4F00-9B32-EF04BEB0DDA0.generation"),
            "camera generation should be 2 for HOME_Eyes_Outdoor",
        ).to.equal(2);
    });

    // ── Test 2: Valid tokens stored → skip login ───────────────────────────────

    it("valid tokens in storage: skips login, arms refresh-loop", async () => {
        // IMPORTANT: stubAxiosSequence must be called BEFORE createAdapter() because
        // createHttpClient() (called in the constructor) copies axios.defaults.adapter at
        // creation time. Patching afterwards doesn't affect the already-created instance.
        stubAxiosSequence([
            {
                status: 200,
                data: CAMERAS_BODY,
            },
        ]);

        const { db, adapter } = createAdapter();

        // Pre-populate token states (simulates a previous run)
        const futureExpiry = Date.now() + 200_000; // 200s from now, well within validity
        db.publishState(`${adapter.namespace}.info.access_token`, {
            val: "stored.access.token",
            ack: true,
        });
        db.publishState(`${adapter.namespace}.info.refresh_token`, {
            val: "stored.refresh.token",
            ack: true,
        });
        db.publishState(`${adapter.namespace}.info.token_expires_at`, {
            val: futureExpiry,
            ack: true,
        });

        await adapter.readyHandler!();

        // Connection should be true (existing tokens were reused, cameras fetched)
        expect(
            getStateVal(db, adapter, "info.connection"),
            "info.connection should be true",
        ).to.equal(true);

        // Token should still be the stored one (no login happened)
        expect(
            getStateVal(db, adapter, "info.access_token"),
            "info.access_token should be the stored token (no re-login)",
        ).to.equal("stored.access.token");
    });

    // ── Test 3: onUnload clears timer, sets connection=false ──────────────────

    it("onUnload: clears refresh-timeout, sets info.connection=false", async () => {
        // Set up a successful start using the PKCE paste flow
        stubAxiosSequence([
            { status: 200, data: TOKEN_BODY },
            { status: 200, data: CAMERAS_BODY },
        ]);

        const { db, adapter } = createAdapter({ redirect_url: REDIRECT_URL_WITH_CODE });
        db.publishState(`${adapter.namespace}.info.pkce_verifier`, {
            val: STORED_PKCE_VERIFIER,
            ack: true,
        });
        db.publishState(`${adapter.namespace}.info.pkce_state`, {
            val: "randomstate123",
            ack: true,
        });
        await adapter.readyHandler!();

        // Confirm adapter is connected after onReady
        expect(getStateVal(db, adapter, "info.connection"), "connected after onReady").to.equal(
            true,
        );

        // Now call unload
        let callbackCalled = false;
        if (adapter.unloadHandler) {
            await new Promise<void>((resolve) => {
                adapter.unloadHandler!(() => {
                    callbackCalled = true;
                    resolve();
                });
            });
        }

        // Callback must be called (ioBroker enforces this)
        expect(callbackCalled, "onUnload callback must be called").to.equal(true);

        // Connection should be false after unload
        // (the setStateAsync in onUnload is async but MockAdapter resolves synchronously)
        expect(
            getStateVal(db, adapter, "info.connection"),
            "info.connection should be false after unload",
        ).to.equal(false);
    });

    // ── Test 4: No tokens + no redirect_url → show login URL, no crash ─────────

    it("no tokens, no redirect_url: logs login URL, sets info.connection=false, does not crash", async () => {
        // No axios stubs needed — adapter should return after logging the URL
        const { db, adapter } = createAdapter({ redirect_url: "" });

        let threw = false;
        try {
            await adapter.readyHandler!();
        } catch {
            threw = true;
        }

        expect(threw, "onReady must not propagate errors").to.equal(false);

        // Connection state should be false — adapter is waiting for user to paste URL
        const conn = getStateVal(db, adapter, "info.connection");
        expect(
            conn === false || conn === undefined || conn === null,
            "info.connection should be false when waiting for login",
        ).to.equal(true);

        // A PKCE verifier should have been stored (new pair generated)
        const verifier = getStateVal(db, adapter, "info.pkce_verifier");
        expect(
            typeof verifier === "string" && (verifier as string).length > 10,
            "pkce_verifier should be stored after showing login URL",
        ).to.equal(true);
    });

    // ── Test 5: redirect_url paste failure → connection stays false ────────────

    it("redirect_url with error param: sets info.connection=false, does not crash", async () => {
        // REDIRECT_URL_WITH_ERROR has ?error=access_denied — extractCode() returns null
        // No HTTP calls needed (code extraction fails before any network call)
        const { db, adapter } = createAdapter({ redirect_url: REDIRECT_URL_WITH_ERROR });
        db.publishState(`${adapter.namespace}.info.pkce_verifier`, {
            val: STORED_PKCE_VERIFIER,
            ack: true,
        });

        let threw = false;
        try {
            await adapter.readyHandler!();
        } catch {
            threw = true;
        }

        expect(threw, "onReady must not propagate errors on paste failure").to.equal(false);
        expect(
            getStateVal(db, adapter, "info.connection"),
            "info.connection should be false after paste failure",
        ).to.equal(false);
    });

    // ── Test 10: redirect_url pasted but no stored PKCE verifier → error ──────

    it("redirect_url pasted but no stored PKCE verifier: logs error, sets info.connection=false", async () => {
        // No verifier stored → adapter cannot complete the exchange
        const { db, adapter } = createAdapter({ redirect_url: REDIRECT_URL_WITH_CODE });
        // Do NOT pre-populate pkce_verifier — it will be absent or empty

        let threw = false;
        try {
            await adapter.readyHandler!();
        } catch {
            threw = true;
        }

        expect(threw, "onReady must not propagate errors").to.equal(false);
        expect(
            getStateVal(db, adapter, "info.connection"),
            "info.connection should be false when PKCE verifier is missing",
        ).to.equal(false);
    });

    // ── Test 11: No tokens, no redirect_url, existing PKCE verifier → reuse ──

    it("no tokens, no redirect_url, stored PKCE verifier: reuses verifier, logs same URL", async () => {
        // No axios stubs needed — adapter should return after logging the URL
        const { db, adapter } = createAdapter({ redirect_url: "" });

        // Pre-populate an existing verifier — adapter should reuse it
        db.publishState(`${adapter.namespace}.info.pkce_verifier`, {
            val: STORED_PKCE_VERIFIER,
            ack: true,
        });
        db.publishState(`${adapter.namespace}.info.pkce_state`, {
            val: "existingstate456",
            ack: true,
        });

        let threw = false;
        try {
            await adapter.readyHandler!();
        } catch {
            threw = true;
        }

        expect(threw, "onReady must not propagate errors").to.equal(false);

        // Verifier should still be the same (not regenerated)
        const verifier = getStateVal(db, adapter, "info.pkce_verifier");
        expect(verifier, "existing PKCE verifier should be reused").to.equal(STORED_PKCE_VERIFIER);
    });
});

// ── v0.2.0 command handler tests ───────────────────────────────────────────────
//
// These tests inject mock implementations of the lib modules (live_session, rcp,
// snapshot, tls_proxy, fcm) into require.cache so that main.js sees the stubs
// instead of the real network-calling code.
//
// Pattern:
//   1. Build the mock lib module exports as plain objects
//   2. Inject into require.cache[RESOLVED_PATH]
//   3. Load main.js fresh (delete require.cache[MAIN_JS_PATH] first)
//   4. Call onReady() to complete startup (with login stubbed)
//   5. Trigger stateChange with ack=false to exercise the handler
//   6. Assert the stubs were called with expected args

describe("main adapter — v0.2.0 command handlers", () => {
    // Resolved paths for the build/ lib modules (used as require.cache keys)
    const LIVE_SESSION_PATH = path.join(REPO_ROOT, "build", "lib", "live_session.js");
    const RCP_PATH = path.join(REPO_ROOT, "build", "lib", "rcp.js");
    const SNAPSHOT_PATH = path.join(REPO_ROOT, "build", "lib", "snapshot.js");
    const TLS_PROXY_PATH = path.join(REPO_ROOT, "build", "lib", "tls_proxy.js");
    const FCM_PATH = path.join(REPO_ROOT, "build", "lib", "fcm.js");
    const SESSION_WATCHDOG_PATH = path.join(REPO_ROOT, "build", "lib", "session_watchdog.js");

    // Real module exports (loaded once so we can restore after each test)
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const realLiveSession = require(LIVE_SESSION_PATH) as object;
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const realRcp = require(RCP_PATH) as object;
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const realSnapshot = require(SNAPSHOT_PATH) as object;
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const realTlsProxy = require(TLS_PROXY_PATH) as object;
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const realFcm = require(FCM_PATH) as object;
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const realSessionWatchdog = require(SESSION_WATCHDOG_PATH) as object;

    /** Inject a fake module into require.cache at the given resolved path. */
    function injectModule(resolvedPath: string, exports: object): void {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (require.cache as any)[resolvedPath] = {
            id: resolvedPath,
            filename: resolvedPath,
            loaded: true,
            parent: module,
            children: [],
            path: path.dirname(resolvedPath),
            paths: [],
            exports,
        };
    }

    /** Restore a real module back into require.cache. */
    function restoreModule(resolvedPath: string, realExports: object): void {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const entry = (require.cache as any)[resolvedPath];
        if (entry) {
            entry.exports = realExports;
        }
    }

    afterEach(() => {
        restoreAxios();
        sinon.restore();
        // Restore real modules
        restoreModule(LIVE_SESSION_PATH, realLiveSession);
        restoreModule(RCP_PATH, realRcp);
        restoreModule(SNAPSHOT_PATH, realSnapshot);
        restoreModule(TLS_PROXY_PATH, realTlsProxy);
        restoreModule(FCM_PATH, realFcm);
        restoreModule(SESSION_WATCHDOG_PATH, realSessionWatchdog);
    });

    /**
     * Create an adapter with all lib modules stubbed out so:
     *   - onReady() completes using stored tokens (no real login)
     *   - openLiveSession returns a canned LOCAL session
     *   - sendRcpCommand resolves with empty payload
     *   - fetchSnapshot returns a 3-byte Buffer
     *   - startTlsProxy returns a dummy handle
     *   - FcmListener.start() throws FcmNotImplementedError (stub behaviour)
     */
    function createAdapterWithMocks(
        opts: {
            openLiveSession?: sinon.SinonStub;
            sendRcpCommand?: sinon.SinonStub;
            fetchSnapshot?: sinon.SinonStub;
            startTlsProxy?: sinon.SinonStub;
            fcmStart?: sinon.SinonStub;
            closeLiveSession?: sinon.SinonStub;
            /** Extra HTTP responses appended AFTER the CAMERAS_BODY response. */
            extraAxiosResponses?: Array<
                Partial<{
                    status: number;
                    data: unknown;
                    headers: Record<string, string | string[]>;
                }>
            >;
        } = {},
    ): { db: MockDatabase; adapter: TestAdapter } {
        // ── Fake live session (LOCAL) ──────────────────────────────────────────
        const fakeSession = {
            cameraId: "EF791764-A48D-4F00-9B32-EF04BEB0DDA0",
            proxyUrl: "https://192.0.2.10:443/snap.jpg?JpegSize=1206",
            connectionType: "LOCAL" as const,
            digestUser: "cbs-testuser",
            digestPassword: "testpassword",
            lanAddress: "192.0.2.10:443",
            bufferingTimeMs: 500,
            maxSessionDuration: 3600,
            openedAt: Date.now(),
        };

        const openLiveSessionStub = opts.openLiveSession ?? sinon.stub().resolves(fakeSession);
        const closeLiveSessionStub = opts.closeLiveSession ?? sinon.stub().resolves(undefined);
        const sendRcpCommandStub =
            opts.sendRcpCommand ?? sinon.stub().resolves({ payload: Buffer.alloc(0) });
        const fetchSnapshotStub =
            opts.fetchSnapshot ?? sinon.stub().resolves(Buffer.from([0xff, 0xd8, 0xff])); // minimal JPEG header
        const tlsStopStub = sinon.stub().resolves(undefined);
        const startTlsProxyStub =
            opts.startTlsProxy ??
            sinon.stub().resolves({
                port: 54321,
                localRtspUrl: "rtsp://127.0.0.1:54321/rtsp_tunnel",
                stop: tlsStopStub,
            });

        // ── FCM stub class ─────────────────────────────────────────────────────
        const { EventEmitter } = require("events") as typeof import("events");

        // FakeFcmCbsRegistrationError must be defined BEFORE FakeFcmListener so
        // the start() stub can throw an instanceof-compatible instance.
        class FakeFcmCbsRegistrationError extends Error {
            constructor() {
                super("CBS registration rejected (fake test error)");
                this.name = "FcmCbsRegistrationError";
            }
        }

        class FakeFcmListener extends EventEmitter {
            // Default: throw FakeFcmCbsRegistrationError to exercise error handling
            start = opts.fcmStart ?? sinon.stub().rejects(new FakeFcmCbsRegistrationError());
            stop = sinon.stub().resolves(undefined);
        }

        // ── Inject mocked modules into require.cache ───────────────────────────
        injectModule(LIVE_SESSION_PATH, {
            openLiveSession: openLiveSessionStub,
            closeLiveSession: closeLiveSessionStub,
            LiveSessionError: class extends Error {},
            CameraOfflineError: class extends Error {},
            SessionLimitError: class extends Error {},
        });

        // Keep real RCP builders but stub sendRcpCommand
        const realRcpExports = realRcp as Record<string, unknown>;
        injectModule(RCP_PATH, {
            ...realRcpExports,
            sendRcpCommand: sendRcpCommandStub,
        });

        injectModule(SNAPSHOT_PATH, {
            fetchSnapshot: fetchSnapshotStub,
            buildSnapshotUrl: (proxyUrl: string) => {
                const base = proxyUrl.replace(/\/+$/, "").replace(/\/snap\.jpg.*$/, "");
                return `${base}/snap.jpg?JpegSize=1206`;
            },
            SnapshotError: class extends Error {},
        });

        injectModule(TLS_PROXY_PATH, {
            startTlsProxy: startTlsProxyStub,
        });

        injectModule(FCM_PATH, {
            FcmListener: FakeFcmListener,
            FcmCbsRegistrationError: FakeFcmCbsRegistrationError,
            CLOUD_API: "https://residential.cbs.boschsecurity.com",
            FCM_SENDER_ID: "404630424405",
        });

        // Inject a no-op SessionWatchdog so tests don't arm real setTimeout timers
        // that could prevent mocha from exiting cleanly.
        class FakeSessionWatchdog {
            start(): void {
                /* no-op */
            }
            stop(): void {
                /* no-op */
            }
            isRunning(): boolean {
                return false;
            }
        }
        injectModule(SESSION_WATCHDOG_PATH, {
            SessionWatchdog: FakeSessionWatchdog,
        });

        // ── Create adapter with stored tokens (skips real login) ───────────────
        // Stub axios for camera discovery (no live-session calls needed in onReady),
        // plus any extra responses the test wants to provide for later HTTP calls
        // (e.g. cloud-API PUT /privacy in handlePrivacyToggle).
        const axiosSeq: Array<
            Partial<{ status: number; data: unknown; headers: Record<string, string | string[]> }>
        > = [{ status: 200, data: CAMERAS_BODY }, ...(opts.extraAxiosResponses ?? [])];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        stubAxiosSequence(axiosSeq as any);

        const { db, adapter } = createAdapter();

        // Pre-populate valid tokens so onReady skips login
        const futureExpiry = Date.now() + 200_000;
        db.publishState(`${adapter.namespace}.info.access_token`, { val: "stored.tok", ack: true });
        db.publishState(`${adapter.namespace}.info.refresh_token`, {
            val: "stored.ref",
            ack: true,
        });
        db.publishState(`${adapter.namespace}.info.token_expires_at`, {
            val: futureExpiry,
            ack: true,
        });

        return { db, adapter };
    }

    // ── Test 6: handlePrivacyToggle (Cloud API) ────────────────────────────────

    it("handlePrivacyToggle: PUT /v11/video_inputs/{id}/privacy with privacyMode body", async () => {
        // CAMERAS_BODY response is added automatically; extra response for the
        // cloud-API PUT /privacy that handlePrivacyToggle issues.
        const { db, adapter } = createAdapterWithMocks({
            extraAxiosResponses: [{ status: 204, data: "" }],
        });

        await adapter.readyHandler!();

        // Simulate user writing cameras.<id>.privacy_enabled = true (ack=false)
        const camId = "EF791764-A48D-4F00-9B32-EF04BEB0DDA0";
        const stateId = `${adapter.namespace}.cameras.${camId}.privacy_enabled`;
        await adapter.stateChangeHandler!(stateId, {
            val: true,
            ack: false,
            ts: 0,
            lc: 0,
            from: "",
        });

        // State should be ack'd after successful PUT
        const state = db.getState(stateId) as ioBroker.State | undefined;
        expect(state?.ack, "state ack'd after successful cloud PUT").to.equal(true);
        expect(state?.val, "state value reflects user request").to.equal(true);
    });

    // ── Test 7: handleSnapshotTrigger ─────────────────────────────────────────

    it("handleSnapshotTrigger: calls openLiveSession + fetchSnapshot + writes snapshot_path", async () => {
        const fakeJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]); // JPEG SOI marker
        const fetchSnapshot = sinon.stub().resolves(fakeJpeg);

        const { db, adapter } = createAdapterWithMocks({ fetchSnapshot });

        await adapter.readyHandler!();

        // Configure the existing writeFileAsync mock (already a sinon stub from @iobroker/testing)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const writeFileStub = (adapter as any).writeFileAsync as sinon.SinonStub;
        if (writeFileStub && typeof writeFileStub.resolves === "function") {
            writeFileStub.resolves(undefined);
        }

        const camId = "EF791764-A48D-4F00-9B32-EF04BEB0DDA0";
        const stateId = `${adapter.namespace}.cameras.${camId}.snapshot_trigger`;
        await adapter.stateChangeHandler!(stateId, {
            val: true,
            ack: false,
            ts: 0,
            lc: 0,
            from: "",
        });

        // fetchSnapshot must have been called
        expect(fetchSnapshot.callCount, "fetchSnapshot called once").to.be.greaterThanOrEqual(1);

        // writeFileAsync must have been called with the JPEG buffer
        expect(writeFileStub.callCount, "writeFileAsync called once").to.be.greaterThanOrEqual(1);

        // snapshot_path state should be set
        const pathState = db.getState(`${adapter.namespace}.cameras.${camId}.snapshot_path`) as
            | ioBroker.State
            | undefined;
        expect(pathState?.val, "snapshot_path state set").to.be.a("string");
        expect(
            (pathState?.val as string).includes(camId),
            "snapshot_path contains camera ID",
        ).to.equal(true);
    });

    // ── Test 8: FCM start fails → info.fcm_active = "error", no crash ─────────
    //
    // FcmNotImplementedError was removed in v0.3.0 when the real @aracna/fcm
    // implementation replaced the stub. This test now verifies that a
    // FcmCbsRegistrationError (CBS auth rejection) is handled gracefully:
    // adapter stays up with info.connection=true, fcm_active="error".

    it("FCM start throws FcmCbsRegistrationError → info.fcm_active=error, no crash", async () => {
        const { db, adapter } = createAdapterWithMocks();

        let threw = false;
        try {
            await adapter.readyHandler!();
        } catch {
            threw = true;
        }

        expect(threw, "onReady must not crash on FcmCbsRegistrationError").to.equal(false);
        expect(
            getStateVal(db, adapter, "info.connection"),
            "info.connection should be true",
        ).to.equal(true);
        expect(
            getStateVal(db, adapter, "info.fcm_active"),
            "info.fcm_active should be 'error' when CBS registration fails",
        ).to.equal("error");
    });

    // ── Test 9: onUnload cleanup ──────────────────────────────────────────────

    it("onUnload: stops TLS proxies, FCM listener, and closes live sessions", async () => {
        const tlsStopStub = sinon.stub().resolves(undefined);
        const startTlsProxy = sinon.stub().resolves({
            port: 44444,
            localRtspUrl: "rtsp://127.0.0.1:44444/rtsp_tunnel",
            stop: tlsStopStub,
        });
        const closeLiveSession = sinon.stub().resolves(undefined);

        const { db, adapter } = createAdapterWithMocks({ startTlsProxy, closeLiveSession });
        await adapter.readyHandler!();

        // Trigger snapshot to open a live session + TLS proxy (privacy now goes
        // directly to cloud API, no live session involved).
        const camId = "EF791764-A48D-4F00-9B32-EF04BEB0DDA0";
        const stateId = `${adapter.namespace}.cameras.${camId}.snapshot_trigger`;
        // Configure writeFileAsync stub so the snapshot handler completes
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const writeFileStub = (adapter as any).writeFileAsync as sinon.SinonStub;
        if (writeFileStub && typeof writeFileStub.resolves === "function") {
            writeFileStub.resolves(undefined);
        }
        await adapter.stateChangeHandler!(stateId, {
            val: true,
            ack: false,
            ts: 0,
            lc: 0,
            from: "",
        });

        // Now unload
        let cbCalled = false;
        if (adapter.unloadHandler) {
            await new Promise<void>((resolve) => {
                adapter.unloadHandler!(() => {
                    cbCalled = true;
                    resolve();
                });
            });
        }

        expect(cbCalled, "unload callback must be called").to.equal(true);

        // TLS proxy must have been stopped
        expect(tlsStopStub.callCount, "TLS proxy stop() called on unload").to.be.greaterThanOrEqual(
            1,
        );

        // Live session must have been closed
        expect(
            closeLiveSession.callCount,
            "closeLiveSession called on unload",
        ).to.be.greaterThanOrEqual(1);

        // info.connection should end up false
        expect(
            getStateVal(db, adapter, "info.connection"),
            "info.connection false after unload",
        ).to.equal(false);
    });

    // ── Test 12: handleImageRotationToggle — pure local flag, no RCP+ / Cloud API ──
    //
    // Regression test for: RCP+ 0x0810 returned HTTP 401 on Gen2 FW 9.40.25.
    // Fix: rotation is a client-side display flag only — Bosch Cloud API exposes
    // no image-rotation endpoint (confirmed in HA integration switch.py).
    // Handler must NOT call sendRcpCommand, NOT open a live session, NOT issue
    // any HTTP PUT — it just stores the flag and acknowledges the ioBroker state.

    it("handleImageRotationToggle: pure local flag — no RCP+, no Cloud PUT, state ack'd", async () => {
        // No extra axios responses needed — handler must NOT issue any HTTP call.
        // If it tries to call sendRcpCommand the stub will be checked below (callCount=0).
        const sendRcpCommandSpy = sinon.stub().resolves({ payload: Buffer.alloc(0) });

        const { db, adapter } = createAdapterWithMocks({
            sendRcpCommand: sendRcpCommandSpy,
            // No extraAxiosResponses — zero additional HTTP calls expected
        });

        await adapter.readyHandler!();

        const camId = "EF791764-A48D-4F00-9B32-EF04BEB0DDA0";
        const stateId = `${adapter.namespace}.cameras.${camId}.image_rotation_180`;

        // Trigger: user sets image_rotation_180 = true
        await adapter.stateChangeHandler!(stateId, {
            val: true,
            ack: false,
            ts: 0,
            lc: 0,
            from: "",
        });

        // State must be ack'd with the requested value
        const state = db.getState(stateId) as ioBroker.State | undefined;
        expect(state?.ack, "image_rotation_180 state must be ack'd").to.equal(true);
        expect(state?.val, "image_rotation_180 state value must be true").to.equal(true);

        // sendRcpCommand must NEVER have been called (no RCP+ for rotation)
        expect(
            sendRcpCommandSpy.callCount,
            "sendRcpCommand must NOT be called for image_rotation_180 (pure local flag)",
        ).to.equal(0);

        // Toggle off
        await adapter.stateChangeHandler!(stateId, {
            val: false,
            ack: false,
            ts: 0,
            lc: 0,
            from: "",
        });

        const stateOff = db.getState(stateId) as ioBroker.State | undefined;
        expect(stateOff?.ack, "image_rotation_180 OFF state must be ack'd").to.equal(true);
        expect(stateOff?.val, "image_rotation_180 OFF state value must be false").to.equal(false);
        expect(
            sendRcpCommandSpy.callCount,
            "sendRcpCommand must still be 0 after rotation-off toggle",
        ).to.equal(0);
    });

    // ── Auto-snapshot after state changes (forum-feedback v0.3.1) ──────────────
    //
    // User report (forum-replies/iobroker-tester-topic): after toggling Privacy
    // OFF or the camera light, the VIS dashboard snapshot stayed stale until the
    // next 5 s refresh interval. The handler must now fire a snapshot fetch
    // fire-and-forget on the side-effecting toggles.
    //   - privacy_enabled=false → auto-snapshot (camera live view returned)
    //   - privacy_enabled=true  → NO auto-snapshot (camera is hidden anyway)
    //   - light_enabled=any     → auto-snapshot (lighting changed)

    /** Yield twice to the event loop so void-Promise auto-snapshots can run + write state. */
    async function flushAutoSnapshot(): Promise<void> {
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));
    }

    it("onStateChange privacy_enabled=false fires auto-snapshot (live view returned)", async () => {
        const fetchSnapshotStub = sinon.stub().resolves(Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
        const { adapter } = createAdapterWithMocks({
            fetchSnapshot: fetchSnapshotStub,
            extraAxiosResponses: [{ status: 200, data: {} }], // PUT /privacy ack
        });
        await adapter.readyHandler!();

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const writeFileStub = (adapter as any).writeFileAsync as sinon.SinonStub;
        if (writeFileStub?.resolves) writeFileStub.resolves(undefined);

        const camId = "EF791764-A48D-4F00-9B32-EF04BEB0DDA0";
        const stateId = `${adapter.namespace}.cameras.${camId}.privacy_enabled`;

        await adapter.stateChangeHandler!(stateId, {
            val: false,
            ack: false,
            ts: 0,
            lc: 0,
            from: "",
        });
        await flushAutoSnapshot();

        expect(
            fetchSnapshotStub.callCount,
            "fetchSnapshot must fire after privacy=false",
        ).to.be.greaterThanOrEqual(1);
    });

    it("onStateChange privacy_enabled=true does NOT fire auto-snapshot (camera hidden)", async () => {
        const fetchSnapshotStub = sinon.stub().resolves(Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
        const { adapter } = createAdapterWithMocks({
            fetchSnapshot: fetchSnapshotStub,
            extraAxiosResponses: [{ status: 200, data: {} }], // PUT /privacy ack
        });
        await adapter.readyHandler!();
        // v0.3.3 fires one startup snapshot per camera so cameras.<id>.online flips
        // from the default false to the real state. Discard those before asserting
        // on the privacy-toggle behaviour.
        await flushAutoSnapshot();
        fetchSnapshotStub.resetHistory();

        const camId = "EF791764-A48D-4F00-9B32-EF04BEB0DDA0";
        const stateId = `${adapter.namespace}.cameras.${camId}.privacy_enabled`;

        await adapter.stateChangeHandler!(stateId, {
            val: true,
            ack: false,
            ts: 0,
            lc: 0,
            from: "",
        });
        await flushAutoSnapshot();

        expect(
            fetchSnapshotStub.callCount,
            "fetchSnapshot must NOT fire when entering privacy mode",
        ).to.equal(0);
    });

    it("onStateChange light_enabled toggle fires auto-snapshot (lighting changed)", async () => {
        const fetchSnapshotStub = sinon.stub().resolves(Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
        const { adapter } = createAdapterWithMocks({
            fetchSnapshot: fetchSnapshotStub,
            extraAxiosResponses: [
                { status: 200, data: {} }, // PUT /lighting/switch/front
                { status: 200, data: {} }, // PUT /lighting/switch/topdown (Gen2)
            ],
        });
        await adapter.readyHandler!();

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const writeFileStub = (adapter as any).writeFileAsync as sinon.SinonStub;
        if (writeFileStub?.resolves) writeFileStub.resolves(undefined);

        const camId = "EF791764-A48D-4F00-9B32-EF04BEB0DDA0";
        const stateId = `${adapter.namespace}.cameras.${camId}.light_enabled`;

        await adapter.stateChangeHandler!(stateId, {
            val: true,
            ack: false,
            ts: 0,
            lc: 0,
            from: "",
        });
        await flushAutoSnapshot();

        expect(
            fetchSnapshotStub.callCount,
            "fetchSnapshot must fire after light toggle",
        ).to.be.greaterThanOrEqual(1);
    });

    // ── Camera reachability / online state ────────────────────────────────────
    //
    // Bosch's list endpoint does not expose connectivity, so the only signal is
    // snapshot success/failure. A single transient "stream has been aborted"
    // (Gen2 idle hiccup) must NOT flip the camera offline — only after
    // OFFLINE_THRESHOLD consecutive failures.

    it("snapshot success sets cameras.<id>.online=true", async () => {
        const { db, adapter } = createAdapterWithMocks({
            fetchSnapshot: sinon.stub().resolves(Buffer.from([0xff, 0xd8, 0xff, 0xe0])),
        });
        await adapter.readyHandler!();

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const writeFileStub = (adapter as any).writeFileAsync as sinon.SinonStub;
        if (writeFileStub?.resolves) writeFileStub.resolves(undefined);

        const camId = "EF791764-A48D-4F00-9B32-EF04BEB0DDA0";
        const stateId = `${adapter.namespace}.cameras.${camId}.snapshot_trigger`;

        await adapter.stateChangeHandler!(stateId, {
            val: true,
            ack: false,
            ts: 0,
            lc: 0,
            from: "",
        });

        const online = db.getState(`${adapter.namespace}.cameras.${camId}.online`) as
            | ioBroker.State
            | undefined;
        expect(online?.val, "online must be true after successful snapshot").to.equal(true);
    });

    // ── v0.5.2: explicit livestream on/off switch (default OFF) ────────────────
    //
    // Bosch counts every open LOCAL session against the daily quota, and the
    // TLS proxy + RTSP watchdog stay running 24/7 once armed. Forum users
    // reported the adapter "always streaming" after a fresh install — this
    // test pins the new opt-in behaviour:
    //   - On fresh install, cameras.<id>.livestream_enabled defaults to false.
    //   - With livestream OFF, snapshots still work but must auto-close the
    //     session + proxy afterwards so nothing keeps running.
    //   - User-write livestream_enabled=true → opens session + proxy + arms
    //     watchdog (verified via stream_url getting populated).
    //   - User-write livestream_enabled=false → tears down (verified via
    //     stream_url cleared + closeLiveSession call).
    // Regression target: a single startup snapshot must NOT leave a 24/7
    // live RTSP stream open against the user's expectation.

    it("livestream_enabled defaults to false on fresh install", async () => {
        const { db, adapter } = createAdapterWithMocks({
            fetchSnapshot: sinon.stub().resolves(Buffer.from([0xff, 0xd8, 0xff, 0xe0])),
        });
        await adapter.readyHandler!();

        const camId = "EF791764-A48D-4F00-9B32-EF04BEB0DDA0";
        const obj = (await adapter.getObjectAsync!(
            `cameras.${camId}.livestream_enabled`,
        )) as ioBroker.StateObject | null | undefined;
        expect(obj, "livestream_enabled object must exist").to.not.equal(null);
        expect(obj?.common.def, "default value must be false").to.equal(false);
        expect(obj?.common.write, "switch must be writable").to.equal(true);

        // Default state value
        const state = db.getState(
            `${adapter.namespace}.cameras.${camId}.livestream_enabled`,
        ) as ioBroker.State | undefined;
        // setObjectNotExistsAsync seeds either no state or def — neither true counts as "off"
        expect(state?.val ?? false, "state value must be falsy on fresh install").to.equal(false);
    });

    it("livestream OFF: startup snapshot arms idle teardown (warm session, no immediate close)", async () => {
        // v0.5.3 changed v0.5.2's "tear down immediately" to a 60 s idle
        // timer so back-to-back snaps can reuse the warm session. Right
        // after the startup snapshot we expect: proxy started, NO stop yet,
        // NO closeLiveSession yet, stream_url populated, idle timer armed.
        const closeLiveSessionStub = sinon.stub().resolves(undefined);
        const tlsStopStub = sinon.stub().resolves(undefined);
        const startTlsProxyStub = sinon.stub().resolves({
            port: 54321,
            localRtspUrl: "rtsp://127.0.0.1:54321/rtsp_tunnel",
            stop: tlsStopStub,
        });
        const { db, adapter } = createAdapterWithMocks({
            fetchSnapshot: sinon.stub().resolves(Buffer.from([0xff, 0xd8, 0xff, 0xe0])),
            closeLiveSession: closeLiveSessionStub,
            startTlsProxy: startTlsProxyStub,
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const writeFileStub = (adapter as any).writeFileAsync as sinon.SinonStub;
        if (writeFileStub?.resolves) writeFileStub.resolves(undefined);

        await adapter.readyHandler!();
        await flushAutoSnapshot();

        const camId = "EF791764-A48D-4F00-9B32-EF04BEB0DDA0";

        // Proxy must have opened at least once during the startup snapshot
        expect(
            startTlsProxyStub.callCount,
            "startTlsProxy fired during the startup snapshot",
        ).to.be.greaterThanOrEqual(1);
        // …but the idle timer hasn't fired yet → no teardown calls observable
        expect(
            tlsStopStub.callCount,
            "TLS proxy stop() must NOT run during the idle window",
        ).to.equal(0);
        expect(
            closeLiveSessionStub.callCount,
            "closeLiveSession must NOT run during the idle window",
        ).to.equal(0);

        // stream_url stays populated for consumers within the warm window
        const streamUrl = db.getState(
            `${adapter.namespace}.cameras.${camId}.stream_url`,
        ) as ioBroker.State | undefined;
        expect(
            (streamUrl?.val as string | undefined) ?? "",
            "stream_url must be set during the idle window so a quick re-poll works",
        ).to.match(/^rtsp:\/\//);

        // Idle timer must be armed for this camera (introspect private state)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const idleTimers = (adapter as any)._snapshotIdleTimers as Map<string, unknown>;
        expect(idleTimers.has(camId), "idle teardown timer armed after startup snapshot").to.equal(
            true,
        );
    });

    it("livestream_enabled=true opens session + populates stream_url", async () => {
        const closeLiveSessionStub = sinon.stub().resolves(undefined);
        const tlsStopStub = sinon.stub().resolves(undefined);
        const startTlsProxyStub = sinon.stub().resolves({
            port: 54321,
            localRtspUrl: "rtsp://127.0.0.1:54321/rtsp_tunnel",
            stop: tlsStopStub,
        });
        const { db, adapter } = createAdapterWithMocks({
            fetchSnapshot: sinon.stub().resolves(Buffer.from([0xff, 0xd8, 0xff, 0xe0])),
            closeLiveSession: closeLiveSessionStub,
            startTlsProxy: startTlsProxyStub,
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const writeFileStub = (adapter as any).writeFileAsync as sinon.SinonStub;
        if (writeFileStub?.resolves) writeFileStub.resolves(undefined);

        await adapter.readyHandler!();
        await flushAutoSnapshot();

        const camId = "EF791764-A48D-4F00-9B32-EF04BEB0DDA0";
        const stateId = `${adapter.namespace}.cameras.${camId}.livestream_enabled`;

        // After startup snapshot the session + proxy are still warm (v0.5.3
        // idle keep-alive). The idle timer must therefore be armed BEFORE
        // the user toggles livestream on; we verify the toggle cancels it.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const idleTimers = (adapter as any)._snapshotIdleTimers as Map<string, unknown>;
        expect(idleTimers.has(camId), "idle timer armed after startup snap").to.equal(true);

        // User flips livestream ON
        await adapter.stateChangeHandler!(stateId, {
            val: true,
            ack: false,
            ts: 0,
            lc: 0,
            from: "",
        });

        // Idle timer must have been cancelled → session stays alive indefinitely
        expect(
            idleTimers.has(camId),
            "idle timer cancelled when livestream goes ON",
        ).to.equal(false);

        // Proxy must have spawned at least once across the lifetime (could be
        // from the startup snap; ensureLiveSession reuses the cached session
        // when livestream goes ON within the keep-alive window — that's the
        // optimisation, not a bug).
        expect(
            startTlsProxyStub.callCount,
            "TLS proxy spawned at least once (startup snap or livestream toggle)",
        ).to.be.greaterThanOrEqual(1);
        const streamUrl = db.getState(
            `${adapter.namespace}.cameras.${camId}.stream_url`,
        ) as ioBroker.State | undefined;
        expect(
            (streamUrl?.val as string | undefined) ?? "",
            "stream_url must be set after livestream_enabled=true",
        ).to.match(/^rtsp:\/\//);

        // ACK on the switch state itself
        const switchState = db.getState(stateId) as ioBroker.State | undefined;
        expect(switchState?.ack, "switch state ack'd after open").to.equal(true);
        expect(switchState?.val, "switch state reflects user request").to.equal(true);
    });

    it("livestream_enabled=false tears down — stream_url cleared + closeLiveSession called", async () => {
        const closeLiveSessionStub = sinon.stub().resolves(undefined);
        const tlsStopStub = sinon.stub().resolves(undefined);
        const startTlsProxyStub = sinon.stub().resolves({
            port: 54321,
            localRtspUrl: "rtsp://127.0.0.1:54321/rtsp_tunnel",
            stop: tlsStopStub,
        });
        const { db, adapter } = createAdapterWithMocks({
            fetchSnapshot: sinon.stub().resolves(Buffer.from([0xff, 0xd8, 0xff, 0xe0])),
            closeLiveSession: closeLiveSessionStub,
            startTlsProxy: startTlsProxyStub,
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const writeFileStub = (adapter as any).writeFileAsync as sinon.SinonStub;
        if (writeFileStub?.resolves) writeFileStub.resolves(undefined);

        await adapter.readyHandler!();
        await flushAutoSnapshot();

        const camId = "EF791764-A48D-4F00-9B32-EF04BEB0DDA0";
        const stateId = `${adapter.namespace}.cameras.${camId}.livestream_enabled`;

        // Bring up the stream first
        await adapter.stateChangeHandler!(stateId, {
            val: true,
            ack: false,
            ts: 0,
            lc: 0,
            from: "",
        });

        // Reset counters after open so we measure only the close path
        tlsStopStub.resetHistory();
        closeLiveSessionStub.resetHistory();

        // User flips livestream OFF
        await adapter.stateChangeHandler!(stateId, {
            val: false,
            ack: false,
            ts: 0,
            lc: 0,
            from: "",
        });

        expect(
            tlsStopStub.callCount,
            "TLS proxy stop() fires on livestream_enabled=false",
        ).to.be.greaterThanOrEqual(1);
        expect(
            closeLiveSessionStub.callCount,
            "closeLiveSession fires on livestream_enabled=false",
        ).to.be.greaterThanOrEqual(1);

        const streamUrl = db.getState(
            `${adapter.namespace}.cameras.${camId}.stream_url`,
        ) as ioBroker.State | undefined;
        expect(streamUrl?.val ?? "", "stream_url cleared after teardown").to.equal("");
    });

    // ── v0.5.3: post-snapshot session keep-alive (idle teardown timer) ─────────
    //
    // Bursts of snapshot_trigger writes (Card opens, automation polling) must
    // reuse the warm Bosch session instead of paying PUT /v11/.../connection
    // on every snap. After the last snap we wait SNAPSHOT_SESSION_IDLE_MS
    // (60 s) before closing the session. Cancelled if the user enables
    // livestream (session stays alive forever) and on adapter unload.

    it("livestream OFF: two rapid snapshots reuse the warm session (openLiveSession called once)", async () => {
        // openLiveSession is the LOCAL session opener — the PUT /connection
        // call we want to amortise. fetchSnapshot is the cheap snap.jpg
        // fetch through the warm proxy. Burst pattern: 2x snapshot_trigger
        // back-to-back → 1x openLiveSession, 2x fetchSnapshot.
        const openLiveSessionStub = sinon.stub().resolves({
            cameraId: "EF791764-A48D-4F00-9B32-EF04BEB0DDA0",
            proxyUrl: "https://192.0.2.10:443/snap.jpg?JpegSize=1206",
            connectionType: "LOCAL" as const,
            digestUser: "cbs-testuser",
            digestPassword: "testpassword",
            lanAddress: "192.0.2.10:443",
            bufferingTimeMs: 500,
            maxSessionDuration: 3600,
            openedAt: Date.now(),
        });
        const fetchSnapshotStub = sinon.stub().resolves(Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
        const { adapter } = createAdapterWithMocks({
            openLiveSession: openLiveSessionStub,
            fetchSnapshot: fetchSnapshotStub,
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const writeFileStub = (adapter as any).writeFileAsync as sinon.SinonStub;
        if (writeFileStub?.resolves) writeFileStub.resolves(undefined);

        await adapter.readyHandler!();
        await flushAutoSnapshot(); // ensure startup snap completes deterministically

        const camId = "EF791764-A48D-4F00-9B32-EF04BEB0DDA0";
        const stateId = `${adapter.namespace}.cameras.${camId}.snapshot_trigger`;

        // Snap #1 — user-triggered, immediately after startup snap
        await adapter.stateChangeHandler!(stateId, {
            val: true,
            ack: false,
            ts: 0,
            lc: 0,
            from: "",
        });
        await flushAutoSnapshot();

        // Snap #2 immediately after — must reuse the cached session
        await adapter.stateChangeHandler!(stateId, {
            val: true,
            ack: false,
            ts: 0,
            lc: 0,
            from: "",
        });
        await flushAutoSnapshot();

        // Total JPEG fetches across lifetime: 1 startup + 2 user triggers = 3
        expect(
            fetchSnapshotStub.callCount,
            "all 3 snaps (startup + 2 user-triggered) fetched the JPEG",
        ).to.be.greaterThanOrEqual(3);
        // …but openLiveSession (PUT /connection — the call we're amortising)
        // must have run exactly once. The startup snap opens, the two
        // follow-up snaps reuse the cached session within SESSION_TTL_MS.
        expect(
            openLiveSessionStub.callCount,
            "openLiveSession (PUT /connection) called only once across the whole burst",
        ).to.equal(1);
    });

    it("livestream OFF: idle teardown fires → closeLiveSession + stream_url cleared", async () => {
        // Drive the timer manually instead of waiting 60 s in tests.
        // _armSnapshotIdleTeardown set the timer; we simulate its firing
        // by invoking _teardownStream directly (same as what the timer
        // callback does).
        const closeLiveSessionStub = sinon.stub().resolves(undefined);
        const tlsStopStub = sinon.stub().resolves(undefined);
        const startTlsProxyStub = sinon.stub().resolves({
            port: 54321,
            localRtspUrl: "rtsp://127.0.0.1:54321/rtsp_tunnel",
            stop: tlsStopStub,
        });
        const { db, adapter } = createAdapterWithMocks({
            fetchSnapshot: sinon.stub().resolves(Buffer.from([0xff, 0xd8, 0xff, 0xe0])),
            closeLiveSession: closeLiveSessionStub,
            startTlsProxy: startTlsProxyStub,
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const writeFileStub = (adapter as any).writeFileAsync as sinon.SinonStub;
        if (writeFileStub?.resolves) writeFileStub.resolves(undefined);

        await adapter.readyHandler!();
        await flushAutoSnapshot();

        const camId = "EF791764-A48D-4F00-9B32-EF04BEB0DDA0";

        // Simulate idle timer firing
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (adapter as any)._teardownStream(camId);

        expect(
            tlsStopStub.callCount,
            "TLS proxy stop() fires when idle teardown runs",
        ).to.be.greaterThanOrEqual(1);
        expect(
            closeLiveSessionStub.callCount,
            "closeLiveSession fires when idle teardown runs",
        ).to.be.greaterThanOrEqual(1);
        const streamUrl = db.getState(
            `${adapter.namespace}.cameras.${camId}.stream_url`,
        ) as ioBroker.State | undefined;
        expect(streamUrl?.val ?? "", "stream_url cleared after idle teardown").to.equal("");
    });

    it("livestream_enabled=true cancels the pending idle teardown timer", async () => {
        const { adapter } = createAdapterWithMocks({
            fetchSnapshot: sinon.stub().resolves(Buffer.from([0xff, 0xd8, 0xff, 0xe0])),
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const writeFileStub = (adapter as any).writeFileAsync as sinon.SinonStub;
        if (writeFileStub?.resolves) writeFileStub.resolves(undefined);

        await adapter.readyHandler!();
        await flushAutoSnapshot();

        const camId = "EF791764-A48D-4F00-9B32-EF04BEB0DDA0";

        // After the startup snapshot the idle timer must be armed
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const idleTimers = (adapter as any)._snapshotIdleTimers as Map<string, unknown>;
        expect(idleTimers.has(camId), "idle timer armed after startup snapshot").to.equal(true);

        // User flips livestream ON → idle timer must be cancelled
        const stateId = `${adapter.namespace}.cameras.${camId}.livestream_enabled`;
        await adapter.stateChangeHandler!(stateId, {
            val: true,
            ack: false,
            ts: 0,
            lc: 0,
            from: "",
        });

        expect(
            idleTimers.has(camId),
            "idle timer cleared once livestream is on (session must stay forever)",
        ).to.equal(false);
    });

    it("onUnload clears pending snapshot idle teardown timers", async () => {
        const { adapter } = createAdapterWithMocks({
            fetchSnapshot: sinon.stub().resolves(Buffer.from([0xff, 0xd8, 0xff, 0xe0])),
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const writeFileStub = (adapter as any).writeFileAsync as sinon.SinonStub;
        if (writeFileStub?.resolves) writeFileStub.resolves(undefined);

        await adapter.readyHandler!();
        await flushAutoSnapshot();

        const camId = "EF791764-A48D-4F00-9B32-EF04BEB0DDA0";
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const idleTimers = (adapter as any)._snapshotIdleTimers as Map<string, unknown>;
        expect(idleTimers.has(camId), "precondition: timer armed after snapshot").to.equal(true);

        // Trigger unload
        if (adapter.unloadHandler) {
            await new Promise<void>((resolve) => {
                adapter.unloadHandler!(() => resolve());
            });
        }

        expect(idleTimers.size, "all idle timers cleared on unload").to.equal(0);
    });

    // ── v0.5.3: motion-event side effects ──────────────────────────────────────
    //
    // FCM (and synthetic) motion events must:
    //  1. set cameras.<id>.motion_active=true with a 90 s auto-clear timer
    //  2. when auto_snapshot_on_motion!=false: fetch a fresh JPEG and
    //     publish it as base64 in cameras.<id>.last_event_image
    //  3. write a matching cameras.<id>.last_event_image_at timestamp

    it("motion event sets motion_active=true and arms auto-clear timer", async () => {
        const { db, adapter } = createAdapterWithMocks({
            fetchSnapshot: sinon.stub().resolves(Buffer.from([0xff, 0xd8, 0xff, 0xe0])),
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const writeFileStub = (adapter as any).writeFileAsync as sinon.SinonStub;
        if (writeFileStub?.resolves) writeFileStub.resolves(undefined);

        await adapter.readyHandler!();
        await flushAutoSnapshot();

        const camId = "EF791764-A48D-4F00-9B32-EF04BEB0DDA0";

        // Drive a synthetic motion event (same _onMotionFired path as FCM)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (adapter as any).triggerSyntheticMotion(camId, "motion");

        const motionActive = db.getState(
            `${adapter.namespace}.cameras.${camId}.motion_active`,
        ) as ioBroker.State | undefined;
        expect(motionActive?.val, "motion_active true after event").to.equal(true);

        // Auto-clear timer must be armed
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const timers = (adapter as any)._motionActiveTimers as Map<string, unknown>;
        expect(timers.has(camId), "motion_active auto-clear timer armed").to.equal(true);
    });

    it("motion event with default config fetches snapshot → last_event_image + _at populated", async () => {
        const fetchSnapshotStub = sinon
            .stub()
            .resolves(Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
        const { db, adapter } = createAdapterWithMocks({
            fetchSnapshot: fetchSnapshotStub,
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const writeFileStub = (adapter as any).writeFileAsync as sinon.SinonStub;
        if (writeFileStub?.resolves) writeFileStub.resolves(undefined);

        await adapter.readyHandler!();
        await flushAutoSnapshot();
        // Reset history so we measure only the motion-triggered snapshot
        fetchSnapshotStub.resetHistory();

        const camId = "EF791764-A48D-4F00-9B32-EF04BEB0DDA0";

        // Drive a synthetic motion event
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (adapter as any).triggerSyntheticMotion(camId, "motion");
        await flushAutoSnapshot();

        expect(
            fetchSnapshotStub.callCount,
            "fetchSnapshot fires on motion event (default config)",
        ).to.be.greaterThanOrEqual(1);

        const img = db.getState(
            `${adapter.namespace}.cameras.${camId}.last_event_image`,
        ) as ioBroker.State | undefined;
        expect(
            (img?.val as string | undefined) ?? "",
            "last_event_image must be a data:image/jpeg;base64 string",
        ).to.match(/^data:image\/jpeg;base64,/);

        const ts = db.getState(
            `${adapter.namespace}.cameras.${camId}.last_event_image_at`,
        ) as ioBroker.State | undefined;
        expect(
            (ts?.val as string | undefined) ?? "",
            "last_event_image_at must be a non-empty ISO timestamp",
        ).to.match(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("auto_snapshot_on_motion=false → no JPEG fetch on motion event", async () => {
        const fetchSnapshotStub = sinon
            .stub()
            .resolves(Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
        const { db, adapter } = createAdapterWithMocks({
            fetchSnapshot: fetchSnapshotStub,
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const writeFileStub = (adapter as any).writeFileAsync as sinon.SinonStub;
        if (writeFileStub?.resolves) writeFileStub.resolves(undefined);

        await adapter.readyHandler!();
        await flushAutoSnapshot();
        fetchSnapshotStub.resetHistory();

        // Opt out of the auto-snapshot
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (adapter as any).config.auto_snapshot_on_motion = false;

        const camId = "EF791764-A48D-4F00-9B32-EF04BEB0DDA0";

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (adapter as any).triggerSyntheticMotion(camId, "motion");
        await flushAutoSnapshot();

        expect(
            fetchSnapshotStub.callCount,
            "fetchSnapshot must NOT fire when auto_snapshot_on_motion is off",
        ).to.equal(0);
        // motion_active must still flip (config flag only gates the snapshot path)
        const motionActive = db.getState(
            `${adapter.namespace}.cameras.${camId}.motion_active`,
        ) as ioBroker.State | undefined;
        expect(
            motionActive?.val,
            "motion_active must still flip even with snapshot off (Blockly trigger)",
        ).to.equal(true);
    });

    // ── v0.5.3: dual stream URL (inst=2 sub-stream alongside inst=1 main) ──

    it("livestream ON publishes both stream_url (inst=1) and stream_url_sub (inst=2)", async () => {
        const { db, adapter } = createAdapterWithMocks({
            fetchSnapshot: sinon.stub().resolves(Buffer.from([0xff, 0xd8, 0xff, 0xe0])),
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const writeFileStub = (adapter as any).writeFileAsync as sinon.SinonStub;
        if (writeFileStub?.resolves) writeFileStub.resolves(undefined);

        await adapter.readyHandler!();
        await flushAutoSnapshot();

        const camId = "EF791764-A48D-4F00-9B32-EF04BEB0DDA0";

        // Toggle livestream ON so both URLs end up populated (and stay populated
        // because the toggle cancels the idle-teardown timer).
        const stateId = `${adapter.namespace}.cameras.${camId}.livestream_enabled`;
        await adapter.stateChangeHandler!(stateId, {
            val: true,
            ack: false,
            ts: 0,
            lc: 0,
            from: "",
        });

        const mainUrl = db.getState(
            `${adapter.namespace}.cameras.${camId}.stream_url`,
        ) as ioBroker.State | undefined;
        const subUrl = db.getState(
            `${adapter.namespace}.cameras.${camId}.stream_url_sub`,
        ) as ioBroker.State | undefined;

        expect(
            (mainUrl?.val as string | undefined) ?? "",
            "stream_url must carry inst=1",
        ).to.match(/[?&]inst=1(&|$)/);
        expect(
            (subUrl?.val as string | undefined) ?? "",
            "stream_url_sub must carry inst=2",
        ).to.match(/[?&]inst=2(&|$)/);
    });

    it("teardown clears both stream_url and stream_url_sub", async () => {
        const { db, adapter } = createAdapterWithMocks({
            fetchSnapshot: sinon.stub().resolves(Buffer.from([0xff, 0xd8, 0xff, 0xe0])),
            closeLiveSession: sinon.stub().resolves(undefined),
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const writeFileStub = (adapter as any).writeFileAsync as sinon.SinonStub;
        if (writeFileStub?.resolves) writeFileStub.resolves(undefined);

        await adapter.readyHandler!();
        await flushAutoSnapshot();

        const camId = "EF791764-A48D-4F00-9B32-EF04BEB0DDA0";

        // Simulate teardown
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (adapter as any)._teardownStream(camId);

        const mainUrl = db.getState(
            `${adapter.namespace}.cameras.${camId}.stream_url`,
        ) as ioBroker.State | undefined;
        const subUrl = db.getState(
            `${adapter.namespace}.cameras.${camId}.stream_url_sub`,
        ) as ioBroker.State | undefined;
        expect(mainUrl?.val ?? "", "stream_url cleared on teardown").to.equal("");
        expect(subUrl?.val ?? "", "stream_url_sub cleared on teardown").to.equal("");
    });

    it("camera flips to offline only after OFFLINE_THRESHOLD consecutive snapshot failures", async () => {
        // 1st call succeeds (camera proven online), then non-transient failures so retry
        // doesn't kick in. Each ioBroker stateChange → snapshot_trigger → 1 fetchSnapshot call.
        //
        // NOTE: onReady fires one startup snapshot as void fire-and-forget. That snapshot
        // may complete before or after the first explicit stateChange trigger, so we allow
        // both call #0 and call #1 to succeed (flushAutoSnapshot ensures the startup
        // snapshot completes before we begin counting failures).
        const fetchSnapshotStub = sinon.stub();
        fetchSnapshotStub.onCall(0).resolves(Buffer.from([0xff, 0xd8, 0xff, 0xe0])); // startup snap
        fetchSnapshotStub.onCall(1).resolves(Buffer.from([0xff, 0xd8, 0xff, 0xe0])); // trigger #1 success
        fetchSnapshotStub.rejects(new Error("HTTP 401: snapshot auth rejected"));

        const { db, adapter } = createAdapterWithMocks({
            fetchSnapshot: fetchSnapshotStub,
        });
        await adapter.readyHandler!();

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const writeFileStub = (adapter as any).writeFileAsync as sinon.SinonStub;
        if (writeFileStub?.resolves) writeFileStub.resolves(undefined);

        // Flush the startup snapshot (fire-and-forget from onReady) so its result
        // does not race with the first explicit trigger below.
        await flushAutoSnapshot();

        const camId = "EF791764-A48D-4F00-9B32-EF04BEB0DDA0";
        const stateId = `${adapter.namespace}.cameras.${camId}.snapshot_trigger`;
        const onlineId = `${adapter.namespace}.cameras.${camId}.online`;

        // Success → online=true
        await adapter.stateChangeHandler!(stateId, {
            val: true,
            ack: false,
            ts: 0,
            lc: 0,
            from: "",
        });
        let online = db.getState(onlineId) as ioBroker.State | undefined;
        expect(online?.val, "online must be true after a successful snapshot").to.equal(true);

        // Fail #1 — must NOT flip back to offline yet
        await adapter.stateChangeHandler!(stateId, {
            val: true,
            ack: false,
            ts: 0,
            lc: 0,
            from: "",
        });
        online = db.getState(onlineId) as ioBroker.State | undefined;
        expect(
            online?.val,
            "online must stay true after a single failure (could be transient)",
        ).to.equal(true);

        // Fail #2 — still online
        await adapter.stateChangeHandler!(stateId, {
            val: true,
            ack: false,
            ts: 0,
            lc: 0,
            from: "",
        });
        online = db.getState(onlineId) as ioBroker.State | undefined;
        expect(online?.val, "online must stay true after 2 failures").to.equal(true);

        // Fail #3 — threshold reached, now offline
        await adapter.stateChangeHandler!(stateId, {
            val: true,
            ack: false,
            ts: 0,
            lc: 0,
            from: "",
        });
        online = db.getState(onlineId) as ioBroker.State | undefined;
        expect(
            online?.val,
            "online must flip to false after OFFLINE_THRESHOLD (3) consecutive failures",
        ).to.equal(false);
    });
});
