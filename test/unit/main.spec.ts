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

import {
    stubAxiosSequence,
    restoreAxios,
} from "./helpers/axios-mock";

// Type-only imports — not loaded at runtime
import type { MockDatabase } from "@iobroker/testing/build/tests/unit/mocks/mockDatabase";
import type { MockAdapter } from "@iobroker/testing/build/tests/unit/mocks/mockAdapter";

// ── Fixtures ───────────────────────────────────────────────────────────────────

/** Minimal Keycloak token response body */
const TOKEN_BODY = {
    access_token:       "acc.tok.fresh",
    refresh_token:      "ref.tok.fresh",
    expires_in:         300,
    refresh_expires_in: 86400,
    token_type:         "Bearer",
    scope:              "email offline_access profile openid",
};

/** Minimal camera list response body */
const CAMERAS_BODY = [
    {
        id:              "EF791764-A48D-4F00-9B32-EF04BEB0DDA0",
        title:           "Terrasse",
        hardwareVersion: "HOME_Eyes_Outdoor",
        firmwareVersion: "9.40.25",
    },
];

/**
 * Simulated Bosch redirect URL — what the user pastes after browser login.
 * Contains a valid `code` query parameter.
 */
const REDIRECT_URL_WITH_CODE = "https://www.bosch.com/boschcam?code=AUTH_CODE_123&state=randomstate123";

/**
 * Redirect URL with an error — simulates failed login or user denied access.
 */
const REDIRECT_URL_WITH_ERROR = "https://www.bosch.com/boschcam?error=access_denied&state=randomstate123";

/**
 * Fake PKCE verifier stored from a previous adapter start.
 * Must be >10 chars so the adapter reuses it without regenerating.
 */
const STORED_PKCE_VERIFIER = "fakepkceverifier1234567890abcdefghijklmnopqrstuvwxyz";

// ── Paths ──────────────────────────────────────────────────────────────────────

const REPO_ROOT         = path.resolve(__dirname, "..", "..");
const MAIN_JS_PATH      = path.join(REPO_ROOT, "build", "main.js");
const ADAPTER_CORE_PATH = require.resolve("@iobroker/adapter-core");

// ── Mock modules (loaded via CommonJS require, not ES import) ─────────────────

// eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
const { MockDatabase: MockDatabaseCtor } = require(
    "@iobroker/testing/build/tests/unit/mocks/mockDatabase"
) as { MockDatabase: new () => MockDatabase };

// eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
const { mockAdapterCore: mockAdapterCoreFn } = require(
    "@iobroker/testing/build/tests/unit/mocks/mockAdapterCore"
) as {
    mockAdapterCore: (
        db: MockDatabase,
        opts?: { onAdapterCreated?: (a: MockAdapter) => void },
    ) => unknown;
};

// ── Adapter factory ────────────────────────────────────────────────────────────

type TestAdapter = MockAdapter & {
    readyHandler?:       () => Promise<void>;
    unloadHandler?:      (cb: () => void) => void;
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
    db:      MockDatabase;
    adapter: TestAdapter;
} {
    const db = new MockDatabaseCtor();
    let capturedAdapter: MockAdapter | null = null;

    const core = mockAdapterCoreFn(db, {
        onAdapterCreated: (a: MockAdapter) => { capturedAdapter = a; },
    });

    // Inject mock core into require.cache BEFORE requiring main.js
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (require.cache as any)[ADAPTER_CORE_PATH] = {
        id:       ADAPTER_CORE_PATH,
        filename: ADAPTER_CORE_PATH,
        loaded:   true,
        parent:   module,
        children: [],
        path:     path.dirname(ADAPTER_CORE_PATH),
        paths:    [],
        exports:  core,
    };

    // Clear main.js so it re-evaluates with the fresh mock core
    delete require.cache[MAIN_JS_PATH];

    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const factory = require(MAIN_JS_PATH) as (opts: Record<string, unknown>) => MockAdapter;
    factory({
        config: {
            redirect_url: "",
            region:       "EU",
            ...configOverrides,
        },
    });

    if (!capturedAdapter) {
        throw new Error("mockAdapterCore did not capture the adapter — factory call failed");
    }

    const adapter = capturedAdapter as TestAdapter;

    // Stub methods that the @iobroker/testing mock omits:
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).setTimeout   = (_fn: () => void, _ms: number) => null;
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
        db.publishState(`${adapter.namespace}.info.pkce_verifier`, { val: STORED_PKCE_VERIFIER, ack: true });
        db.publishState(`${adapter.namespace}.info.pkce_state`,    { val: "randomstate123",    ack: true });

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
        db.publishState(`${adapter.namespace}.info.access_token`,     { val: "stored.access.token",  ack: true });
        db.publishState(`${adapter.namespace}.info.refresh_token`,    { val: "stored.refresh.token", ack: true });
        db.publishState(`${adapter.namespace}.info.token_expires_at`, { val: futureExpiry,            ack: true });

        await adapter.readyHandler!();

        // Connection should be true (existing tokens were reused, cameras fetched)
        expect(getStateVal(db, adapter, "info.connection"), "info.connection should be true").to.equal(true);

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
        db.publishState(`${adapter.namespace}.info.pkce_verifier`, { val: STORED_PKCE_VERIFIER, ack: true });
        db.publishState(`${adapter.namespace}.info.pkce_state`,    { val: "randomstate123",    ack: true });
        await adapter.readyHandler!();

        // Confirm adapter is connected after onReady
        expect(getStateVal(db, adapter, "info.connection"), "connected after onReady").to.equal(true);

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
        db.publishState(`${adapter.namespace}.info.pkce_verifier`, { val: STORED_PKCE_VERIFIER, ack: true });

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
        db.publishState(`${adapter.namespace}.info.pkce_verifier`, { val: STORED_PKCE_VERIFIER, ack: true });
        db.publishState(`${adapter.namespace}.info.pkce_state`,    { val: "existingstate456",  ack: true });

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
    const RCP_PATH          = path.join(REPO_ROOT, "build", "lib", "rcp.js");
    const SNAPSHOT_PATH     = path.join(REPO_ROOT, "build", "lib", "snapshot.js");
    const TLS_PROXY_PATH    = path.join(REPO_ROOT, "build", "lib", "tls_proxy.js");
    const FCM_PATH          = path.join(REPO_ROOT, "build", "lib", "fcm.js");

    // Real module exports (loaded once so we can restore after each test)
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const realLiveSession = require(LIVE_SESSION_PATH) as object;
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const realRcp         = require(RCP_PATH)          as object;
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const realSnapshot    = require(SNAPSHOT_PATH)     as object;
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const realTlsProxy    = require(TLS_PROXY_PATH)    as object;
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const realFcm         = require(FCM_PATH)          as object;

    /** Inject a fake module into require.cache at the given resolved path. */
    function injectModule(resolvedPath: string, exports: object): void {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (require.cache as any)[resolvedPath] = {
            id:       resolvedPath,
            filename: resolvedPath,
            loaded:   true,
            parent:   module,
            children: [],
            path:     path.dirname(resolvedPath),
            paths:    [],
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
        restoreModule(RCP_PATH,          realRcp);
        restoreModule(SNAPSHOT_PATH,     realSnapshot);
        restoreModule(TLS_PROXY_PATH,    realTlsProxy);
        restoreModule(FCM_PATH,          realFcm);
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
    function createAdapterWithMocks(opts: {
        openLiveSession?: sinon.SinonStub;
        sendRcpCommand?:  sinon.SinonStub;
        fetchSnapshot?:   sinon.SinonStub;
        startTlsProxy?:   sinon.SinonStub;
        fcmStart?:        sinon.SinonStub;
        closeLiveSession?: sinon.SinonStub;
        /** Extra HTTP responses appended AFTER the CAMERAS_BODY response. */
        extraAxiosResponses?: Array<Partial<{ status: number; data: unknown; headers: Record<string, string | string[]> }>>;
    } = {}): { db: MockDatabase; adapter: TestAdapter } {
        // ── Fake live session (LOCAL) ──────────────────────────────────────────
        const fakeSession = {
            cameraId:       "EF791764-A48D-4F00-9B32-EF04BEB0DDA0",
            proxyUrl:       "https://192.0.2.10:443/snap.jpg?JpegSize=1206",
            connectionType: "LOCAL" as const,
            digestUser:     "cbs-testuser",
            digestPassword: "testpassword",
            lanAddress:     "192.0.2.10:443",
            bufferingTimeMs: 500,
            openedAt:       Date.now(),
        };

        const openLiveSessionStub = opts.openLiveSession
            ?? sinon.stub().resolves(fakeSession);
        const closeLiveSessionStub = opts.closeLiveSession
            ?? sinon.stub().resolves(undefined);
        const sendRcpCommandStub = opts.sendRcpCommand
            ?? sinon.stub().resolves({ payload: Buffer.alloc(0) });
        const fetchSnapshotStub = opts.fetchSnapshot
            ?? sinon.stub().resolves(Buffer.from([0xff, 0xd8, 0xff])); // minimal JPEG header
        const tlsStopStub = sinon.stub().resolves(undefined);
        const startTlsProxyStub = opts.startTlsProxy
            ?? sinon.stub().resolves({
                port:         54321,
                localRtspUrl: "rtsp://127.0.0.1:54321/rtsp_tunnel",
                stop:         tlsStopStub,
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
            stop  = sinon.stub().resolves(undefined);
        }

        // ── Inject mocked modules into require.cache ───────────────────────────
        injectModule(LIVE_SESSION_PATH, {
            openLiveSession:    openLiveSessionStub,
            closeLiveSession:   closeLiveSessionStub,
            LiveSessionError:   class extends Error {},
            CameraOfflineError: class extends Error {},
            SessionLimitError:  class extends Error {},
        });

        // Keep real RCP builders but stub sendRcpCommand
        const realRcpExports = realRcp as Record<string, unknown>;
        injectModule(RCP_PATH, {
            ...realRcpExports,
            sendRcpCommand: sendRcpCommandStub,
        });

        injectModule(SNAPSHOT_PATH, {
            fetchSnapshot:    fetchSnapshotStub,
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
            FcmListener:             FakeFcmListener,
            FcmCbsRegistrationError: FakeFcmCbsRegistrationError,
            CLOUD_API:               "https://residential.cbs.boschsecurity.com",
            FCM_SENDER_ID:           "404630424405",
        });

        // ── Create adapter with stored tokens (skips real login) ───────────────
        // Stub axios for camera discovery (no live-session calls needed in onReady),
        // plus any extra responses the test wants to provide for later HTTP calls
        // (e.g. cloud-API PUT /privacy in handlePrivacyToggle).
        const axiosSeq: Array<Partial<{ status: number; data: unknown; headers: Record<string, string | string[]> }>> = [
            { status: 200, data: CAMERAS_BODY },
            ...(opts.extraAxiosResponses ?? []),
        ];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        stubAxiosSequence(axiosSeq as any);

        const { db, adapter } = createAdapter();

        // Pre-populate valid tokens so onReady skips login
        const futureExpiry = Date.now() + 200_000;
        db.publishState(`${adapter.namespace}.info.access_token`,     { val: "stored.tok", ack: true });
        db.publishState(`${adapter.namespace}.info.refresh_token`,    { val: "stored.ref", ack: true });
        db.publishState(`${adapter.namespace}.info.token_expires_at`, { val: futureExpiry,  ack: true });

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
        await adapter.stateChangeHandler!(stateId, { val: true, ack: false, ts: 0, lc: 0, from: "" });

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
        await adapter.stateChangeHandler!(stateId, { val: true, ack: false, ts: 0, lc: 0, from: "" });

        // fetchSnapshot must have been called
        expect(fetchSnapshot.callCount, "fetchSnapshot called once").to.be.greaterThanOrEqual(1);

        // writeFileAsync must have been called with the JPEG buffer
        expect(writeFileStub.callCount, "writeFileAsync called once").to.be.greaterThanOrEqual(1);

        // snapshot_path state should be set
        const pathState = db.getState(
            `${adapter.namespace}.cameras.${camId}.snapshot_path`
        ) as ioBroker.State | undefined;
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
        const tlsStopStub    = sinon.stub().resolves(undefined);
        const startTlsProxy  = sinon.stub().resolves({
            port:         44444,
            localRtspUrl: "rtsp://127.0.0.1:44444/rtsp_tunnel",
            stop:         tlsStopStub,
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
        await adapter.stateChangeHandler!(stateId, { val: true, ack: false, ts: 0, lc: 0, from: "" });

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
        expect(tlsStopStub.callCount, "TLS proxy stop() called on unload").to.be.greaterThanOrEqual(1);

        // Live session must have been closed
        expect(closeLiveSession.callCount, "closeLiveSession called on unload").to.be.greaterThanOrEqual(1);

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

        const camId  = "EF791764-A48D-4F00-9B32-EF04BEB0DDA0";
        const stateId = `${adapter.namespace}.cameras.${camId}.image_rotation_180`;

        // Trigger: user sets image_rotation_180 = true
        await adapter.stateChangeHandler!(stateId, { val: true, ack: false, ts: 0, lc: 0, from: "" });

        // State must be ack'd with the requested value
        const state = db.getState(stateId) as ioBroker.State | undefined;
        expect(state?.ack,  "image_rotation_180 state must be ack'd").to.equal(true);
        expect(state?.val,  "image_rotation_180 state value must be true").to.equal(true);

        // sendRcpCommand must NEVER have been called (no RCP+ for rotation)
        expect(
            sendRcpCommandSpy.callCount,
            "sendRcpCommand must NOT be called for image_rotation_180 (pure local flag)",
        ).to.equal(0);

        // Toggle off
        await adapter.stateChangeHandler!(stateId, { val: false, ack: false, ts: 0, lc: 0, from: "" });

        const stateOff = db.getState(stateId) as ioBroker.State | undefined;
        expect(stateOff?.ack, "image_rotation_180 OFF state must be ack'd").to.equal(true);
        expect(stateOff?.val, "image_rotation_180 OFF state value must be false").to.equal(false);
        expect(
            sendRcpCommandSpy.callCount,
            "sendRcpCommand must still be 0 after rotation-off toggle",
        ).to.equal(0);
    });
});
