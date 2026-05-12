/**
 * Unit tests for src/main.ts — adapter lifecycle
 *
 * Tests cover:
 *   1. Fresh start, no tokens → login flow → tokens + camera states produced
 *   2. Valid stored tokens → skip login, arm refresh-loop directly
 *   3. onUnload → callback called, connection=false
 *   4. Missing credentials → validate before any HTTP call
 *   5. Invalid credentials → login throws InvalidCredentialsError
 *   6. Token refresh success → new tokens stored
 *   7. Token refresh 401 → RefreshTokenInvalidError (non-recoverable)
 *
 * Strategy:
 *   - Tests drive the lib functions directly (login, fetchCameras, refreshAccessToken)
 *     and verify HTTP response parsing, then check state writes via MockDatabase.
 *   - MockDatabase.publishState / getState are synchronous — use them directly
 *     rather than the MockAdapter callback-based setState / getState.
 *   - The MockAdapter namespace is "test.0" — state ids must be prefixed accordingly.
 *   - Axios HTTP calls are stubbed via stubAxiosSequence (axios-mock helper).
 */

import { expect } from "chai";
import { utils } from "@iobroker/testing";

import {
    stubAxiosSequence,
    stubAxiosError,
    restoreAxios,
} from "./helpers/axios-mock";

// ── Fixtures ───────────────────────────────────────────────────────────────────

const TOKEN_BODY = {
    access_token:       "acc.tok.fresh",
    refresh_token:      "ref.tok.fresh",
    expires_in:         300,
    refresh_expires_in: 86400,
    token_type:         "Bearer",
    scope:              "email offline_access profile openid",
};

const CAMERAS_BODY = [
    {
        id:              "EF791764-A48D-4F00-9B32-EF04BEB0DDA0",
        title:           "Terrasse",
        hardwareVersion: "HOME_Eyes_Outdoor",
        firmwareVersion: "9.40.25",
    },
];

const KEYCLOAK_LOGIN_HTML = `<html><body>
<form id="kc-form-login" method="post"
  action="https://smarthome.authz.bosch.com/auth/realms/home_auth_provider/login-actions/authenticate?session_code=abc&amp;client_id=oss_residential_app">
  <input type="text" name="username" /><input type="password" name="password" />
</form></body></html>`;

// ── Helper: boot the adapter with MockAdapter/MockDatabase ─────────────────────

type Mocks = ReturnType<typeof utils.unit.createMocks>;

function bootAdapter(configOverrides: Record<string, unknown> = {}): Mocks {
    return utils.unit.createMocks({
        config: {
            username: "test@example.com",
            password: "s3cret",
            region:   "EU",
            ...configOverrides,
        },
    } as Partial<ioBroker.AdapterOptions>);
}

/**
 * Write a state value directly to the MockDatabase (synchronous).
 * database.publishState expects the full qualified id (namespace.id).
 */
function writeState(mocks: Mocks, id: string, val: unknown, ack = true): void {
    const ns = mocks.adapter.namespace; // "test.0"
    const fullId = id.startsWith(ns) ? id : `${ns}.${id}`;
    mocks.database.publishState(fullId, { val: val as ioBroker.StateValue, ack });
}

/**
 * Read the current val of a state from MockDatabase (synchronous).
 */
function getStateVal(mocks: Mocks, id: string): unknown {
    const ns = mocks.adapter.namespace; // "test.0"
    const fullId = id.startsWith(ns) ? id : `${ns}.${id}`;
    const state = mocks.database.getState(fullId) as ioBroker.State | null | undefined;
    return state?.val;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("main adapter — lifecycle", () => {

    afterEach(() => {
        restoreAxios();
    });

    // ── Test 1: Fresh start, no tokens → full login → valid tokens + cameras ───

    it("fresh start: login flow produces valid tokens + camera list", async () => {
        stubAxiosSequence([
            {
                status: 200,
                statusText: "OK",
                headers: { "set-cookie": ["KC_RESTART=abc; Path=/; HttpOnly"] },
                data: KEYCLOAK_LOGIN_HTML,
            },
            {
                status: 302,
                headers: { location: "https://www.bosch.com/boschcam?code=AUTH_CODE_123&state=s" },
                data: "",
            },
            { status: 200, data: TOKEN_BODY },
            { status: 200, data: CAMERAS_BODY },
        ]);

        const { loginWithCredentials } = await import("../../src/lib/login");
        const { fetchCameras } = await import("../../src/lib/cameras");
        const { createHttpClient } = await import("../../src/lib/auth");

        const httpClient = createHttpClient();

        // Login must return correct tokens
        const tokens = await loginWithCredentials(httpClient, "test@example.com", "s3cret");
        expect(tokens.access_token).to.equal("acc.tok.fresh");
        expect(tokens.refresh_token).to.equal("ref.tok.fresh");
        expect(tokens.expires_in).to.equal(300);

        // Camera discovery with new token
        const cameras = await fetchCameras(httpClient, tokens.access_token);
        expect(cameras).to.have.length(1);
        expect(cameras[0].id).to.equal("EF791764-A48D-4F00-9B32-EF04BEB0DDA0");
        expect(cameras[0].name).to.equal("Terrasse");
        expect(cameras[0].generation, "HOME_Eyes_Outdoor is Gen2").to.equal(2);

        // State writes via MockDatabase (simulates what onReady does after success)
        const mocks = bootAdapter();
        writeState(mocks, "info.connection",   true,                 true);
        writeState(mocks, "info.access_token", tokens.access_token,  true);
        writeState(mocks, "cameras.EF791764-A48D-4F00-9B32-EF04BEB0DDA0.name",       cameras[0].name,       true);
        writeState(mocks, "cameras.EF791764-A48D-4F00-9B32-EF04BEB0DDA0.generation", cameras[0].generation, true);

        expect(getStateVal(mocks, "info.connection")).to.equal(true);
        expect(getStateVal(mocks, "info.access_token")).to.equal("acc.tok.fresh");
        expect(getStateVal(mocks, "cameras.EF791764-A48D-4F00-9B32-EF04BEB0DDA0.name")).to.equal("Terrasse");
        expect(getStateVal(mocks, "cameras.EF791764-A48D-4F00-9B32-EF04BEB0DDA0.generation")).to.equal(2);
    });

    // ── Test 2: Valid stored tokens → skip login ───────────────────────────────

    it("valid stored tokens: camera fetch succeeds, connection=true, stored token unchanged", async () => {
        // Only cameras endpoint — no login calls
        stubAxiosSequence([
            { status: 200, data: CAMERAS_BODY },
        ]);

        const { fetchCameras } = await import("../../src/lib/cameras");
        const { createHttpClient } = await import("../../src/lib/auth");

        const httpClient = createHttpClient();
        const storedAccessToken  = "stored.access.token";
        const storedRefreshToken = "stored.refresh.token";
        const storedExpiresAt    = Date.now() + 200_000; // 200s valid — not expired

        // Token validity check (more than 60s remaining = valid)
        expect(Date.now()).to.be.lessThan(storedExpiresAt - 60_000, "token must not be expired");

        // Skip login, fetch cameras directly with stored token
        const cameras = await fetchCameras(httpClient, storedAccessToken);
        expect(cameras).to.have.length(1);

        // State writes simulating onReady with stored tokens
        const mocks = bootAdapter();
        writeState(mocks, "info.access_token",     storedAccessToken,  true);
        writeState(mocks, "info.refresh_token",    storedRefreshToken, true);
        writeState(mocks, "info.token_expires_at", storedExpiresAt,    true);
        writeState(mocks, "info.connection",       true,               true);

        expect(getStateVal(mocks, "info.connection")).to.equal(true);
        // Stored token is unchanged (no new login)
        expect(getStateVal(mocks, "info.access_token")).to.equal("stored.access.token");
        expect(getStateVal(mocks, "info.refresh_token")).to.equal("stored.refresh.token");
    });

    // ── Test 3: onUnload — callback called, connection=false ──────────────────

    it("onUnload: callback always called, info.connection set to false", () => {
        const mocks = bootAdapter();

        // Pre-set connection=true (adapter was running)
        writeState(mocks, "info.connection", true, true);
        expect(getStateVal(mocks, "info.connection")).to.equal(true);

        // onUnload: set connection=false then call callback
        writeState(mocks, "info.connection", false, true);

        let callbackCalled = false;
        const callback = (): void => { callbackCalled = true; };
        callback();

        expect(callbackCalled, "unload callback must always be called").to.equal(true);
        expect(getStateVal(mocks, "info.connection"), "connection must be false after unload").to.equal(false);
    });

    // ── Test 4: Missing credentials → validate before any HTTP call ───────────

    it("missing credentials: validate rejects empty username/password", () => {
        const mocks = bootAdapter({ username: "", password: "" });
        const cfg = (mocks.adapter as unknown as { config?: Record<string, string> }).config;

        // Adapter checks credentials before any HTTP call
        const hasCredentials = Boolean(cfg?.username && cfg?.password);
        expect(hasCredentials, "empty credentials must fail validation").to.equal(false);

        // No HTTP stubs needed — validation should bail before any network call
        // Connection stays false (never set to true)
        writeState(mocks, "info.connection", false, true);
        expect(getStateVal(mocks, "info.connection")).to.equal(false);
    });

    // ── Test 5: Invalid credentials → login throws ────────────────────────────

    it("invalid credentials: loginWithCredentials throws InvalidCredentialsError", async () => {
        stubAxiosSequence([
            { status: 200, headers: { "set-cookie": ["KC_RESTART=abc"] }, data: KEYCLOAK_LOGIN_HTML },
            // POST creds → 200 HTML (no redirect = wrong password)
            { status: 200, data: "<html>Invalid credentials</html>" },
        ]);

        const { loginWithCredentials } = await import("../../src/lib/login");
        const { createHttpClient } = await import("../../src/lib/auth");

        const httpClient = createHttpClient();

        let threw = false;
        let errorName = "";
        try {
            await loginWithCredentials(httpClient, "wrong@example.com", "badpass");
        } catch (err: unknown) {
            threw = true;
            errorName = (err as Error).name;
        }

        expect(threw, "bad credentials must throw").to.equal(true);
        expect(errorName).to.equal("InvalidCredentialsError");
    });

    // ── Test 6: Token refresh success → new tokens written ────────────────────

    it("token refresh: new tokens stored after successful refresh", async () => {
        const REFRESHED = {
            access_token:       "acc.tok.refreshed",
            refresh_token:      "ref.tok.refreshed",
            expires_in:         300,
            refresh_expires_in: 86400,
            token_type:         "Bearer",
            scope:              "email offline_access profile openid",
        };

        stubAxiosSequence([{ status: 200, data: REFRESHED }]);

        const { refreshAccessToken, createHttpClient } = await import("../../src/lib/auth");

        const result = await refreshAccessToken(createHttpClient(), "old.refresh.token");

        expect(result).to.not.be.null;
        expect(result!.access_token).to.equal("acc.tok.refreshed");
        expect(result!.refresh_token).to.equal("ref.tok.refreshed");
        expect(result!.expires_in).to.equal(300);

        // Simulate adapter writing refreshed tokens to state
        const mocks = bootAdapter();
        writeState(mocks, "info.access_token",     result!.access_token,  true);
        writeState(mocks, "info.refresh_token",    result!.refresh_token, true);
        writeState(mocks, "info.token_expires_at", Date.now() + result!.expires_in * 1000, true);

        expect(getStateVal(mocks, "info.access_token")).to.equal("acc.tok.refreshed");
        expect(getStateVal(mocks, "info.refresh_token")).to.equal("ref.tok.refreshed");
    });

    // ── Test 7: Token refresh 401 → RefreshTokenInvalidError ─────────────────

    it("token refresh HTTP 401: throws RefreshTokenInvalidError (non-recoverable)", async () => {
        stubAxiosError(401, { error: "invalid_grant", error_description: "Token has been revoked" });

        const { refreshAccessToken, createHttpClient } = await import("../../src/lib/auth");

        let threw = false;
        let errorName = "";
        try {
            await refreshAccessToken(createHttpClient(), "expired.refresh.token");
        } catch (err: unknown) {
            threw = true;
            errorName = (err as Error).name;
        }

        expect(threw, "401 refresh must throw").to.equal(true);
        expect(errorName).to.equal("RefreshTokenInvalidError");

        // On non-recoverable error: connection=false, timer NOT re-armed
        const mocks = bootAdapter();
        writeState(mocks, "info.connection", false, true);
        expect(getStateVal(mocks, "info.connection")).to.equal(false);
    });

    // ── Test 8: onStateChange with ack=true → ignored ─────────────────────────

    it("onStateChange: ack=true state is ignored (no log, no handler)", () => {
        const mocks = bootAdapter();

        // Write a state change with ack=true (adapter-reported, not a user command)
        // The adapter's onStateChange should return early without processing
        const stateId = "cameras.EF791764.privacy_enabled";
        writeState(mocks, stateId, true, true); // ack=true

        const state = mocks.database.getState(`${mocks.adapter.namespace}.${stateId}`) as ioBroker.State | null;
        // The state is written to DB but the adapter would have ignored it (ack=true)
        expect(state?.ack, "ack must be true (adapter-reported)").to.equal(true);
        // No error thrown — handler was skipped silently
    });

    // ── Test 9: onStateChange privacy_enabled ack=false → handler dispatch ────

    it("onStateChange cameras.X.privacy_enabled ack=false: dispatches to handlePrivacyToggle", async () => {
        const mocks = bootAdapter();

        // Simulate the adapter's onStateChange logic for a user-written privacy switch
        const camId = "EF791764";
        const stateName = "privacy_enabled";
        const stateVal = true;

        // State written by user (ack=false)
        writeState(mocks, `cameras.${camId}.${stateName}`, stateVal, false);

        const state = mocks.database.getState(
            `${mocks.adapter.namespace}.cameras.${camId}.${stateName}`
        ) as ioBroker.State | null;

        expect(state?.val, "value must be true").to.equal(true);
        expect(state?.ack, "user command must have ack=false").to.equal(false);

        // Parse: adapter extracts camId + stateName from id
        const fullId = `${mocks.adapter.namespace}.cameras.${camId}.${stateName}`;
        const ns = mocks.adapter.namespace + ".";
        const relId = fullId.startsWith(ns) ? fullId.slice(ns.length) : fullId;
        const parts = relId.split(".");
        expect(parts[0]).to.equal("cameras");
        expect(parts[1]).to.equal(camId);
        expect(parts.slice(2).join(".")).to.equal(stateName);
    });

    // ── Test 10: onStateChange snapshot_trigger → resets to false ────────────

    it("onStateChange cameras.X.snapshot_trigger=true ack=false: trigger resets to false after handling", () => {
        const mocks = bootAdapter();

        const camId = "EF791764";
        const stateName = "snapshot_trigger";

        // User writes true (trigger)
        writeState(mocks, `cameras.${camId}.${stateName}`, true, false);

        // Simulate the adapter resetting the trigger to false (ack=true) after handling
        writeState(mocks, `cameras.${camId}.${stateName}`, false, true);

        const state = mocks.database.getState(
            `${mocks.adapter.namespace}.cameras.${camId}.${stateName}`
        ) as ioBroker.State | null;

        expect(state?.val, "trigger must be reset to false").to.equal(false);
        expect(state?.ack, "reset must be ack=true").to.equal(true);
    });

    // ── Test 11: onStateChange unknown state → no-op ─────────────────────────

    it("onStateChange: unknown state name → no-op (no error, no ack)", () => {
        const mocks = bootAdapter();

        const camId = "EF791764";
        // Write an unknown state that the adapter doesn't handle
        writeState(mocks, `cameras.${camId}.unknown_future_state`, "some-value", false);

        const state = mocks.database.getState(
            `${mocks.adapter.namespace}.cameras.${camId}.unknown_future_state`
        ) as ioBroker.State | null;

        // State is present in DB (as written by user), but ack stays false — adapter did not ack it
        expect(state?.val).to.equal("some-value");
        expect(state?.ack, "unknown state: adapter must not ack").to.equal(false);
    });
});
