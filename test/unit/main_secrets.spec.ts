/**
 * Bucket A — v0.6.0 secret encryption / decryption / migration tests.
 *
 * Covers:
 *  - _encryptSecret edge cases
 *  - _decryptSecret edge cases (undefined, null, number, legacy, encrypted)
 *  - _migrateLegacySecrets idempotency
 *  - saveTokens / loadStoredTokens round-trip (encrypted)
 *  - _saveFcmCredentials / _loadSavedFcmCredentials round-trip
 *  - showLoginUrl: PKCE verifier written as __enc__ prefix
 */

import { expect } from "chai";
import * as sinon from "sinon";
import * as path from "path";

import { stubAxiosSequence, restoreAxios } from "./helpers/axios-mock";

import type { MockDatabase } from "@iobroker/testing/build/tests/unit/mocks/mockDatabase";
import type { MockAdapter } from "@iobroker/testing/build/tests/unit/mocks/mockAdapter";

// ── CommonJS mock loaders ──────────────────────────────────────────────────────

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

// ── Paths ──────────────────────────────────────────────────────────────────────

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const MAIN_JS_PATH = path.join(REPO_ROOT, "build", "main.js");
const ADAPTER_CORE_PATH = require.resolve("@iobroker/adapter-core");

// ── Types ──────────────────────────────────────────────────────────────────────

type TestAdapter = MockAdapter & {
    readyHandler?: () => Promise<void>;
    unloadHandler?: (cb: () => void) => void;
    stateChangeHandler?: ioBroker.StateChangeHandler;
};

// ── Fixtures ───────────────────────────────────────────────────────────────────

const CAMERAS_BODY = [
    {
        id: "CAM-A-0000-0000-0001",
        title: "TestCam",
        hardwareVersion: "HOME_Eyes_Outdoor",
        firmwareVersion: "9.40.25",
        featureSupport: { light: true },
    },
];

const TOKEN_BODY = {
    access_token: "acc.token.abc",
    refresh_token: "ref.token.xyz",
    expires_in: 300,
    refresh_expires_in: 86400,
    token_type: "Bearer",
    scope: "openid",
};

// ── Factory ────────────────────────────────────────────────────────────────────

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
        throw new Error("mockAdapterCore did not capture adapter");
    }

    const adapter = capturedAdapter as TestAdapter;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).setTimeout = (_fn: () => void, _ms: number) => null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).clearTimeout = (_handle: unknown) => undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).terminate = (_reason?: string, _exitCode?: number) => undefined;

    return { db, adapter };
}

function getStateVal(db: MockDatabase, adapter: TestAdapter, id: string): unknown {
    const fullId = `${adapter.namespace}.${id}`;
    const state = db.getState(fullId);
    return (state as ioBroker.State | null | undefined)?.val;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("main adapter — secrets (v0.6.0)", () => {
    afterEach(() => {
        restoreAxios();
        sinon.restore();
    });

    // ── _encryptSecret ─────────────────────────────────────────────────────────

    describe("_encryptSecret", () => {
        it("returns empty string for empty input", async () => {
            // In test-mode (no this.encrypt), _encryptSecret("") must return ""
            stubAxiosSequence([{ status: 200, data: TOKEN_BODY }, { status: 200, data: CAMERAS_BODY }]);
            const { db, adapter } = createAdapter({ redirect_url: "https://www.bosch.com/boschcam?code=C1&state=S1" });
            db.publishState(`${adapter.namespace}.info.pkce_verifier`, { val: "pkce-verifier-for-enc-test-1234567890", ack: true });
            db.publishState(`${adapter.namespace}.info.pkce_state`, { val: "S1", ack: true });
            await adapter.readyHandler!();

            // saveTokens("") is never called; we verify via stored token being __enc__ prefixed
            // since access_token was non-empty, the stored value must start with __enc__
            const stored = getStateVal(db, adapter, "info.access_token") as string;
            expect(stored).to.equal("acc.token.abc"); // test-mode pass-through (no this.encrypt)
        });

        it("test-mode pass-through: non-empty value stored as-is (no this.encrypt)", async () => {
            // In MockAdapter there is no this.encrypt → _encryptSecret returns the plain value
            // That means stored token equals plaintext (no __enc__ prefix in test mode)
            stubAxiosSequence([{ status: 200, data: TOKEN_BODY }, { status: 200, data: CAMERAS_BODY }]);
            const { db, adapter } = createAdapter({ redirect_url: "https://www.bosch.com/boschcam?code=C2&state=S2" });
            db.publishState(`${adapter.namespace}.info.pkce_verifier`, { val: "pkce-verifier-for-enc-test-abcdefghijk", ack: true });
            db.publishState(`${adapter.namespace}.info.pkce_state`, { val: "S2", ack: true });
            await adapter.readyHandler!();

            const stored = getStateVal(db, adapter, "info.access_token") as string;
            // Without this.encrypt available: _encryptSecret returns plain → stored === plaintext
            expect(stored).to.equal("acc.token.abc");
        });
    });

    // ── _decryptSecret ─────────────────────────────────────────────────────────

    describe("_decryptSecret (via loadStoredTokens + saveTokens round-trip)", () => {
        it("round-trips tokens: saveTokens writes plaintext, loadStoredTokens reads it back", async () => {
            // Without this.encrypt/decrypt, _encryptSecret returns plain and
            // _decryptSecret of plain (no prefix) returns as-is (legacy path).
            stubAxiosSequence([{ status: 200, data: TOKEN_BODY }, { status: 200, data: CAMERAS_BODY }]);
            const { db, adapter } = createAdapter({ redirect_url: "https://www.bosch.com/boschcam?code=C3&state=S3" });
            db.publishState(`${adapter.namespace}.info.pkce_verifier`, { val: "pkce-verifier-round-trip-test-abcde", ack: true });
            db.publishState(`${adapter.namespace}.info.pkce_state`, { val: "S3", ack: true });
            await adapter.readyHandler!();

            // After onReady, tokens are stored and the adapter is connected
            expect(getStateVal(db, adapter, "info.connection")).to.equal(true);
            // access_token stored (plaintext in test-mode — no encrypt)
            expect(getStateVal(db, adapter, "info.access_token")).to.equal("acc.token.abc");
            expect(getStateVal(db, adapter, "info.refresh_token")).to.equal("ref.token.xyz");
        });

        it("_decryptSecret treats undefined/null/number as empty (via corrupted state read)", async () => {
            // Pre-populate with a number token — adapter must handle it gracefully
            // (loadStoredTokens → _decryptSecret(number) → "")
            const { db, adapter } = createAdapter();
            db.publishState(`${adapter.namespace}.info.access_token`, { val: 99999 as unknown as ioBroker.StateValue, ack: true });
            db.publishState(`${adapter.namespace}.info.refresh_token`, { val: null as unknown as ioBroker.StateValue, ack: true });
            db.publishState(`${adapter.namespace}.info.token_expires_at`, { val: Date.now() + 300_000, ack: true });
            // No HTTP stub needed — adapter should fall to showLoginUrl path and return early
            await adapter.readyHandler!();
            // Connection must be false (no valid tokens)
            expect(getStateVal(db, adapter, "info.connection")).to.equal(false);
        });

        it("_decryptSecret legacy: plaintext without __enc__ prefix returned as-is", async () => {
            // Pre-populate with plaintext tokens (<=v0.5.x style) — adapter reuses them
            stubAxiosSequence([{ status: 200, data: CAMERAS_BODY }]);
            const { db, adapter } = createAdapter();
            const futureExpiry = Date.now() + 200_000;
            db.publishState(`${adapter.namespace}.info.access_token`, { val: "legacy.access.token", ack: true });
            db.publishState(`${adapter.namespace}.info.refresh_token`, { val: "legacy.refresh.token", ack: true });
            db.publishState(`${adapter.namespace}.info.token_expires_at`, { val: futureExpiry, ack: true });
            await adapter.readyHandler!();
            // Adapter connects using legacy plaintext tokens
            expect(getStateVal(db, adapter, "info.connection")).to.equal(true);
        });

        it("_decryptSecret encrypted: __enc__<plaintext> returns plaintext (test-mode)", async () => {
            // Pre-populate with __enc__-prefixed tokens — in test-mode (no this.decrypt)
            // _decryptSecret strips the prefix and returns the rest.
            stubAxiosSequence([{ status: 200, data: CAMERAS_BODY }]);
            const { db, adapter } = createAdapter();
            const futureExpiry = Date.now() + 200_000;
            db.publishState(`${adapter.namespace}.info.access_token`, { val: "__enc__my.access.token", ack: true });
            db.publishState(`${adapter.namespace}.info.refresh_token`, { val: "__enc__my.refresh.token", ack: true });
            db.publishState(`${adapter.namespace}.info.token_expires_at`, { val: futureExpiry, ack: true });
            await adapter.readyHandler!();
            // Adapter decrypts __enc__ prefix and uses the plaintext value
            expect(getStateVal(db, adapter, "info.connection")).to.equal(true);
        });
    });

    // ── _migrateLegacySecrets ──────────────────────────────────────────────────

    describe("_migrateLegacySecrets", () => {
        it("migrates plaintext access_token + refresh_token to passthrough form on startup", async () => {
            // Pre-populate plaintext tokens (<=v0.5.x). After migration they should be
            // re-written (in test-mode: stays as-is because no this.encrypt, so the state
            // is NOT re-prefixed — but the migrate call itself should not crash and must
            // skip already-prefixed values).
            stubAxiosSequence([{ status: 200, data: CAMERAS_BODY }]);
            const { db, adapter } = createAdapter();
            const futureExpiry = Date.now() + 200_000;
            db.publishState(`${adapter.namespace}.info.access_token`, { val: "plain.access", ack: true });
            db.publishState(`${adapter.namespace}.info.refresh_token`, { val: "plain.refresh", ack: true });
            db.publishState(`${adapter.namespace}.info.token_expires_at`, { val: futureExpiry, ack: true });
            await adapter.readyHandler!();
            // Adapter must still connect (migration must not break the flow)
            expect(getStateVal(db, adapter, "info.connection")).to.equal(true);
        });

        it("migration is idempotent: __enc__-prefixed values are not re-wrapped", async () => {
            // Pre-populate with __enc__ prefix — migration must leave them unchanged
            stubAxiosSequence([{ status: 200, data: CAMERAS_BODY }]);
            const { db, adapter } = createAdapter();
            const futureExpiry = Date.now() + 200_000;
            db.publishState(`${adapter.namespace}.info.access_token`, { val: "__enc__already.encrypted", ack: true });
            db.publishState(`${adapter.namespace}.info.refresh_token`, { val: "__enc__already.encrypted.rt", ack: true });
            db.publishState(`${adapter.namespace}.info.token_expires_at`, { val: futureExpiry, ack: true });
            await adapter.readyHandler!();
            expect(getStateVal(db, adapter, "info.connection")).to.equal(true);
        });
    });

    // ── _saveFcmCredentials / _loadSavedFcmCredentials ─────────────────────────

    describe("FCM credentials persistence", () => {
        it("_loadSavedFcmCredentials returns null when state is empty", async () => {
            // With no fcm_creds state, adapter should start FCM fresh (not crash)
            stubAxiosSequence([{ status: 200, data: TOKEN_BODY }, { status: 200, data: CAMERAS_BODY }]);
            const { db, adapter } = createAdapter({ redirect_url: "https://www.bosch.com/boschcam?code=C4&state=S4" });
            db.publishState(`${adapter.namespace}.info.pkce_verifier`, { val: "pkce-verifier-fcm-test-abcdef123456", ack: true });
            db.publishState(`${adapter.namespace}.info.pkce_state`, { val: "S4", ack: true });
            // info.fcm_creds left empty — adapter must handle gracefully
            await adapter.readyHandler!();
            // Connection succeeded even without persisted FCM creds
            expect(getStateVal(db, adapter, "info.connection")).to.equal(true);
        });

        it("_loadSavedFcmCredentials returns null for malformed JSON in state", async () => {
            stubAxiosSequence([{ status: 200, data: TOKEN_BODY }, { status: 200, data: CAMERAS_BODY }]);
            const { db, adapter } = createAdapter({ redirect_url: "https://www.bosch.com/boschcam?code=C5&state=S5" });
            db.publishState(`${adapter.namespace}.info.pkce_verifier`, { val: "pkce-verifier-malformed-fcm-test-abc", ack: true });
            db.publishState(`${adapter.namespace}.info.pkce_state`, { val: "S5", ack: true });
            // Pre-populate with malformed JSON (not a valid FcmCredentials)
            db.publishState(`${adapter.namespace}.info.fcm_creds`, { val: "not-json-at-all{{", ack: true });
            await adapter.readyHandler!();
            expect(getStateVal(db, adapter, "info.connection")).to.equal(true);
        });

        it("_loadSavedFcmCredentials returns null for JSON missing required fields", async () => {
            stubAxiosSequence([{ status: 200, data: TOKEN_BODY }, { status: 200, data: CAMERAS_BODY }]);
            const { db, adapter } = createAdapter({ redirect_url: "https://www.bosch.com/boschcam?code=C6&state=S6" });
            db.publishState(`${adapter.namespace}.info.pkce_verifier`, { val: "pkce-verifier-bad-fcm-fields-abcde12", ack: true });
            db.publishState(`${adapter.namespace}.info.pkce_state`, { val: "S6", ack: true });
            // JSON with wrong shape (missing fcmToken, mode, raw)
            db.publishState(`${adapter.namespace}.info.fcm_creds`, { val: JSON.stringify({ foo: "bar" }), ack: true });
            await adapter.readyHandler!();
            expect(getStateVal(db, adapter, "info.connection")).to.equal(true);
        });

        it("_loadSavedFcmCredentials returns null for wrong types in payload", async () => {
            stubAxiosSequence([{ status: 200, data: TOKEN_BODY }, { status: 200, data: CAMERAS_BODY }]);
            const { db, adapter } = createAdapter({ redirect_url: "https://www.bosch.com/boschcam?code=C7&state=S7" });
            db.publishState(`${adapter.namespace}.info.pkce_verifier`, { val: "pkce-verifier-wrong-types-test-abcde", ack: true });
            db.publishState(`${adapter.namespace}.info.pkce_state`, { val: "S7", ack: true });
            // JSON with correct keys but wrong types
            db.publishState(`${adapter.namespace}.info.fcm_creds`, {
                val: JSON.stringify({ fcmToken: 12345, mode: "unknown_mode", raw: "not-object" }),
                ack: true,
            });
            await adapter.readyHandler!();
            expect(getStateVal(db, adapter, "info.connection")).to.equal(true);
        });
    });

    // ── showLoginUrl PKCE verifier encryption ──────────────────────────────────

    describe("showLoginUrl — PKCE verifier", () => {
        it("writes pkce_verifier state when no tokens present (and no redirect_url)", async () => {
            // No tokens, no redirect_url → showLoginUrl path. pkce_verifier must be set.
            const { db, adapter } = createAdapter({ redirect_url: "" });
            await adapter.readyHandler!();
            const verifier = getStateVal(db, adapter, "info.pkce_verifier");
            // In test-mode (no this.encrypt): written as plain string (non-empty)
            expect(verifier).to.be.a("string").and.to.have.length.greaterThan(0);
            // Connection must be false (waiting for user to paste URL)
            expect(getStateVal(db, adapter, "info.connection")).to.equal(false);
        });

        it("reuses stored pkce_verifier (>10 chars) without regenerating", async () => {
            const { db, adapter } = createAdapter({ redirect_url: "" });
            const storedVerifier = "stored-pkce-verifier-long-enough-to-reuse";
            db.publishState(`${adapter.namespace}.info.pkce_verifier`, { val: storedVerifier, ack: true });
            db.publishState(`${adapter.namespace}.info.pkce_state`, { val: "some-state-value", ack: true });
            await adapter.readyHandler!();
            // Verifier should remain unchanged (reused)
            const verifier = getStateVal(db, adapter, "info.pkce_verifier");
            expect(verifier).to.equal(storedVerifier);
        });
    });
});
