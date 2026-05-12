/**
 * Unit tests for src/lib/login.ts
 *
 * Covers:
 *   - loginWithCredentials()    — full end-to-end flow (happy path + all error paths)
 *   - extractFormAction()       — HTML parsing for Keycloak form action URL
 *   - extractCodeFromLocation() — code extraction from Location header
 *
 * Framework: Mocha + Chai + Sinon
 * Mocking:   stubAxiosSequence / stubAxiosError / restoreAxios from helpers/axios-mock.ts
 *            Sinon stubs for generatePkcePair / buildAuthUrl / exchangeCode
 */

import { expect } from "chai";
import * as sinon from "sinon";
import axios from "axios";

import {
    loginWithCredentials,
    extractFormAction,
    extractCodeFromLocation,
    InvalidCredentialsError,
    MfaRequiredError,
    LoginFlowError,
} from "../../src/lib/login";

import * as authModule from "../../src/lib/auth";
import { RefreshTokenInvalidError } from "../../src/lib/auth";

import {
    stubAxiosSequence,
    stubAxiosError,
    restoreAxios,
} from "./helpers/axios-mock";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const FAKE_PKCE = { verifier: "test-verifier-64chars-paddedXXXXXXXXXXXXXXXXXXXXXXXX", challenge: "test-challenge-43charsXXXXXXXXXXXXXXXXXXX" };
const FAKE_AUTH_URL = "https://smarthome.authz.bosch.com/auth/realms/home_auth_provider/protocol/openid-connect/auth?client_id=oss_residential_app&response_type=code&scope=email+offline_access+profile+openid&redirect_uri=https%3A%2F%2Fwww.bosch.com%2Fboschcam&code_challenge=test-challenge&code_challenge_method=S256&state=test-state";
const FAKE_ACTION_URL = "https://smarthome.authz.bosch.com/auth/realms/home_auth_provider/login-actions/authenticate?session_code=abc123&execution=xyz&client_id=oss_residential_app&tab_id=tab1";
const FAKE_LOCATION = "https://www.bosch.com/boschcam?code=AUTH_CODE_XYZ&state=test-state";
const FAKE_MFA_LOCATION = "https://smarthome.authz.bosch.com/auth/realms/home_auth_provider/login-actions/authenticate?execution=otp&client_id=oss_residential_app";
const KEYCLOAK_HTML = `<!DOCTYPE html>
<html><body>
<form id="kc-form-login" action="${FAKE_ACTION_URL}" method="post">
  <input type="text" name="username" />
  <input type="password" name="password" />
  <input type="submit" value="Log In" />
</form>
</body></html>`;

const TOKEN_BODY = {
    access_token:       "acc.jwt.here",
    refresh_token:      "ref.jwt.here",
    expires_in:         300,
    refresh_expires_in: 86400,
    token_type:         "Bearer",
    scope:              "email offline_access profile openid",
};

// ── extractFormAction() ───────────────────────────────────────────────────────

describe("extractFormAction()", () => {
    it("extracts action URL from standard Keycloak form HTML", () => {
        const result = extractFormAction(KEYCLOAK_HTML);
        expect(result).to.equal(FAKE_ACTION_URL);
    });

    it("decodes &amp; HTML entities in action URL", () => {
        const html = `<form action="https://example.com/auth?foo=1&amp;bar=2">`;
        const result = extractFormAction(html);
        expect(result).to.equal("https://example.com/auth?foo=1&bar=2");
    });

    it("returns null when no form tag in HTML", () => {
        const result = extractFormAction("<html><body>No form here</body></html>");
        expect(result).to.be.null;
    });

    it("returns null for empty string", () => {
        const result = extractFormAction("");
        expect(result).to.be.null;
    });

    it("handles form with extra attributes before action", () => {
        const html = `<form id="login" class="form-horizontal" action="https://example.com/login">`;
        const result = extractFormAction(html);
        expect(result).to.equal("https://example.com/login");
    });
});

// ── extractCodeFromLocation() ─────────────────────────────────────────────────

describe("extractCodeFromLocation()", () => {
    it("extracts code from a full redirect URL", () => {
        const result = extractCodeFromLocation(FAKE_LOCATION);
        expect(result).to.equal("AUTH_CODE_XYZ");
    });

    it("returns null when URL contains error param", () => {
        const result = extractCodeFromLocation("https://www.bosch.com/boschcam?error=access_denied");
        expect(result).to.be.null;
    });

    it("returns null when no code param in URL", () => {
        const result = extractCodeFromLocation("https://www.bosch.com/boschcam?state=only");
        expect(result).to.be.null;
    });

    it("returns null for MFA redirect URL (no code)", () => {
        const result = extractCodeFromLocation(FAKE_MFA_LOCATION);
        expect(result).to.be.null;
    });

    it("returns null for malformed URL", () => {
        const result = extractCodeFromLocation("not-a-url-at-all");
        expect(result).to.be.null;
    });
});

// ── loginWithCredentials() ────────────────────────────────────────────────────

describe("loginWithCredentials()", () => {
    let pkceSub: sinon.SinonStub;
    let authUrlSub: sinon.SinonStub;
    let exchangeSub: sinon.SinonStub;

    beforeEach(() => {
        // Stub PKCE and auth URL generation so we control the flow deterministically
        pkceSub    = sinon.stub(authModule, "generatePkcePair").returns(FAKE_PKCE);
        authUrlSub = sinon.stub(authModule, "buildAuthUrl").returns(FAKE_AUTH_URL);
        // exchangeCode is called at the end — stub per test where needed
        exchangeSub = sinon.stub(authModule, "exchangeCode");
    });

    afterEach(() => {
        sinon.restore();
        restoreAxios();
    });

    // ── Test 1: Happy path ────────────────────────────────────────────────────

    it("happy path: returns TokenResult when full flow succeeds", async () => {
        exchangeSub.resolves(TOKEN_BODY);

        stubAxiosSequence([
            // GET auth page → HTML with form action
            {
                status: 200,
                data: KEYCLOAK_HTML,
                headers: { "set-cookie": "AUTH_SESSION_ID=sess123; Path=/; HttpOnly" },
            },
            // POST credentials → 302 redirect with code
            {
                status: 302,
                data: "",
                headers: { location: FAKE_LOCATION },
            },
        ]);

        const result = await loginWithCredentials(axios.create(), "user@example.com", "secret");

        expect(result.access_token).to.equal(TOKEN_BODY.access_token);
        expect(result.refresh_token).to.equal(TOKEN_BODY.refresh_token);
        expect(result.expires_in).to.equal(TOKEN_BODY.expires_in);
        expect(pkceSub.calledOnce).to.be.true;
        expect(authUrlSub.calledOnce).to.be.true;
        expect(exchangeSub.calledOnceWith(sinon.match.any, "AUTH_CODE_XYZ", FAKE_PKCE.verifier)).to.be.true;
    });

    // ── Test 2: Wrong credentials → InvalidCredentialsError ──────────────────

    it("throws InvalidCredentialsError when POST returns 200 (no redirect = wrong password)", async () => {
        const errorHtml = `<html><body><span class="kc-feedback-text">Invalid username or password.</span></body></html>`;

        stubAxiosSequence([
            { status: 200, data: KEYCLOAK_HTML, headers: {} },
            { status: 200, data: errorHtml, headers: {} },  // no Location, no redirect
        ]);

        try {
            await loginWithCredentials(axios.create(), "user@example.com", "wrongpassword");
            expect.fail("should have thrown");
        } catch (err: unknown) {
            expect(err).to.be.instanceOf(InvalidCredentialsError);
            expect((err as InvalidCredentialsError).name).to.equal("InvalidCredentialsError");
        }
    });

    // ── Test 3: MFA required → MfaRequiredError ───────────────────────────────

    it("throws MfaRequiredError when POST redirects to MFA page (no code in Location)", async () => {
        stubAxiosSequence([
            { status: 200, data: KEYCLOAK_HTML, headers: {} },
            { status: 302, data: "", headers: { location: FAKE_MFA_LOCATION } },
        ]);

        try {
            await loginWithCredentials(axios.create(), "user@example.com", "secret");
            expect.fail("should have thrown");
        } catch (err: unknown) {
            expect(err).to.be.instanceOf(MfaRequiredError);
            expect((err as MfaRequiredError).name).to.equal("MfaRequiredError");
        }
    });

    // ── Test 4: Network error during GET → LoginFlowError ────────────────────

    it("throws LoginFlowError on network error during GET auth page", async () => {
        const savedAdapter = axios.defaults.adapter;
        axios.defaults.adapter = (): Promise<never> => {
            const err = Object.assign(new Error("ECONNREFUSED"), { isAxiosError: true });
            return Promise.reject(err);
        };

        try {
            await loginWithCredentials(axios.create(), "user@example.com", "secret");
            expect.fail("should have thrown");
        } catch (err: unknown) {
            expect(err).to.be.instanceOf(LoginFlowError);
            expect((err as LoginFlowError).name).to.equal("LoginFlowError");
        } finally {
            axios.defaults.adapter = savedAdapter as typeof axios.defaults.adapter;
        }
    });

    // ── Test 5: Network error during POST → LoginFlowError ───────────────────

    it("throws LoginFlowError on network error during credentials POST", async () => {
        let callCount = 0;
        const savedAdapter = axios.defaults.adapter;
        axios.defaults.adapter = (config): Promise<never> | Promise<ReturnType<typeof Object.assign>> => {
            callCount++;
            if (callCount === 1) {
                // First call (GET) succeeds
                return Promise.resolve(Object.assign({}, {
                    status: 200,
                    statusText: "OK",
                    data: KEYCLOAK_HTML,
                    headers: {},
                    config,
                    request: {},
                }));
            }
            // Second call (POST) fails with network error
            const err = Object.assign(new Error("ETIMEDOUT"), { isAxiosError: true });
            return Promise.reject(err);
        };

        try {
            await loginWithCredentials(axios.create(), "user@example.com", "secret");
            expect.fail("should have thrown");
        } catch (err: unknown) {
            expect(err).to.be.instanceOf(LoginFlowError);
        } finally {
            axios.defaults.adapter = savedAdapter as typeof axios.defaults.adapter;
        }
    });

    // ── Test 6: 5xx during GET → LoginFlowError ──────────────────────────────

    it("throws LoginFlowError on 5xx response during GET auth page", async () => {
        stubAxiosError(503, "Service Unavailable");

        try {
            await loginWithCredentials(axios.create(), "user@example.com", "secret");
            expect.fail("should have thrown");
        } catch (err: unknown) {
            expect(err).to.be.instanceOf(LoginFlowError);
            expect((err as LoginFlowError).message).to.include("503");
        }
    });

    // ── Test 7: 5xx during POST → LoginFlowError ─────────────────────────────

    it("throws LoginFlowError on 5xx during credentials POST", async () => {
        stubAxiosSequence([
            { status: 200, data: KEYCLOAK_HTML, headers: {} },
            { status: 500, data: "Internal Server Error", headers: {} },
        ]);

        try {
            await loginWithCredentials(axios.create(), "user@example.com", "secret");
            expect.fail("should have thrown");
        } catch (err: unknown) {
            expect(err).to.be.instanceOf(LoginFlowError);
            expect((err as LoginFlowError).message).to.include("500");
        }
    });

    // ── Test 8: Form action URL missing in HTML → LoginFlowError ─────────────

    it("throws LoginFlowError when form action URL is not found in HTML", async () => {
        const htmlWithoutForm = "<html><body><p>No login form here.</p></body></html>";

        stubAxiosSequence([
            { status: 200, data: htmlWithoutForm, headers: {} },
        ]);

        try {
            await loginWithCredentials(axios.create(), "user@example.com", "secret");
            expect.fail("should have thrown");
        } catch (err: unknown) {
            expect(err).to.be.instanceOf(LoginFlowError);
            expect((err as LoginFlowError).message).to.include("form action");
        }
    });

    // ── Test 9: Code missing from redirect Location → MfaRequiredError ───────

    it("throws MfaRequiredError when 302 Location has no code param", async () => {
        stubAxiosSequence([
            { status: 200, data: KEYCLOAK_HTML, headers: {} },
            { status: 302, data: "", headers: { location: "https://www.bosch.com/boschcam?state=only" } },
        ]);

        try {
            await loginWithCredentials(axios.create(), "user@example.com", "secret");
            expect.fail("should have thrown");
        } catch (err: unknown) {
            expect(err).to.be.instanceOf(MfaRequiredError);
        }
    });

    // ── Test 10: exchangeCode throws RefreshTokenInvalidError → bubbles up ────

    it("bubbles up RefreshTokenInvalidError from exchangeCode", async () => {
        exchangeSub.rejects(new RefreshTokenInvalidError("Token exchange: HTTP 400 invalid_grant"));

        stubAxiosSequence([
            { status: 200, data: KEYCLOAK_HTML, headers: {} },
            { status: 302, data: "", headers: { location: FAKE_LOCATION } },
        ]);

        try {
            await loginWithCredentials(axios.create(), "user@example.com", "secret");
            expect.fail("should have thrown");
        } catch (err: unknown) {
            expect(err).to.be.instanceOf(RefreshTokenInvalidError);
            expect((err as RefreshTokenInvalidError).name).to.equal("RefreshTokenInvalidError");
        }
    });

    // ── Test 11: exchangeCode returns null → LoginFlowError ──────────────────

    it("throws LoginFlowError when exchangeCode returns null (transient network error)", async () => {
        exchangeSub.resolves(null);

        stubAxiosSequence([
            { status: 200, data: KEYCLOAK_HTML, headers: {} },
            { status: 302, data: "", headers: { location: FAKE_LOCATION } },
        ]);

        try {
            await loginWithCredentials(axios.create(), "user@example.com", "secret");
            expect.fail("should have thrown");
        } catch (err: unknown) {
            expect(err).to.be.instanceOf(LoginFlowError);
            expect((err as LoginFlowError).message).to.include("null");
        }
    });

    // ── Test 12: Cookie relay ─────────────────────────────────────────────────

    it("relays Set-Cookie from GET response as Cookie header in POST", async () => {
        exchangeSub.resolves(TOKEN_BODY);

        // We need to inspect what headers the POST received — capture via custom adapter
        let postCookieHeader: string | undefined;
        const savedAdapter = axios.defaults.adapter;
        let callCount = 0;
        axios.defaults.adapter = (config): Promise<ReturnType<typeof Object.assign>> => {
            callCount++;
            if (callCount === 1) {
                // GET → return HTML with Set-Cookie
                return Promise.resolve(Object.assign({}, {
                    status: 200, statusText: "OK",
                    data: KEYCLOAK_HTML,
                    headers: { "set-cookie": ["AUTH_SESSION_ID=sess42; Path=/; HttpOnly"] },
                    config, request: {},
                }));
            }
            // POST → capture Cookie header, return 302
            postCookieHeader = config.headers?.["Cookie"] as string | undefined;
            return Promise.resolve(Object.assign({}, {
                status: 302, statusText: "Found",
                data: "",
                headers: { location: FAKE_LOCATION },
                config, request: {},
            }));
        };

        try {
            await loginWithCredentials(axios.create(), "user@example.com", "secret");
            expect(postCookieHeader).to.include("AUTH_SESSION_ID=sess42");
        } finally {
            axios.defaults.adapter = savedAdapter as typeof axios.defaults.adapter;
        }
    });
});
