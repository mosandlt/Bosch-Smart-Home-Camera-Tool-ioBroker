/**
 * Unit tests for src/lib/login.ts
 *
 * Covers:
 *   - loginWithCredentials()    — full 2-step flow (happy path + all error paths)
 *   - parseFormFields()         — form action + CSRF extraction (no-action and explicit-action forms)
 *   - extractCodeFromLocation() — code extraction from final redirect URL
 *   - detectCaptcha()           — hCaptcha / reCAPTCHA detection
 *   - detectMfa()               — 2FA / MFA page detection
 *   - extractFormAction()       — backward-compat helper (Keycloak-style explicit action=)
 *
 * 2-step flow (SingleKey ID, as of 2026-05-13):
 *   GET auth URL → email page (no action attr, posts to same URL)
 *   POST email → password page (blocked by hCaptcha in production)
 *   POST password → OIDC callback URL with ?code=...
 *   exchangeCode → tokens
 *
 * hCaptcha blocker: singlekey-id.com requires a real captcha token to advance from
 * email to password page. Headless login throws MfaRequiredError("hCaptcha required…").
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
    parseFormFields,
    extractFormAction,
    extractCodeFromLocation,
    detectCaptcha,
    detectMfa,
    InvalidCredentialsError,
    MfaRequiredError,
    LoginFlowError,
} from "../../src/lib/login";

import * as authModule from "../../src/lib/auth";
import { RefreshTokenInvalidError } from "../../src/lib/auth";

import { stubAxiosSequence, stubAxiosError, restoreAxios } from "./helpers/axios-mock";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const FAKE_PKCE = {
    verifier: "test-verifier-64chars-paddedXXXXXXXXXXXXXXXXXXXXXXXX",
    challenge: "test-challenge-43charsXXXXXXXXXXXXXXXXXXX",
};
const FAKE_AUTH_URL =
    "https://smarthome.authz.bosch.com/auth/realms/home_auth_provider/protocol/openid-connect/auth" +
    "?client_id=oss_residential_app&state=test-state";
const FAKE_EMAIL_PAGE_URL =
    "https://singlekey-id.com/en-gb/login?ReturnUrl=%2Fauth%2Fconnect%2Fauthorize%2Fcallback";
const FAKE_PASSWORD_PAGE_URL =
    "https://singlekey-id.com/en-gb/login?Current=%5B%5D&returnUrl=%2Fauth%2Fconnect";
const FAKE_CALLBACK_URL = "https://www.bosch.com/boschcam?code=AUTH_CODE_XYZ&state=test-state";
const FAKE_MFA_LOCATION = "https://singlekey-id.com/en-gb/mfa?returnUrl=%2Fauth%2Fconnect";

const CSRF_TOKEN = "CfDJ8IjSH_mU-EpAg-FAKE_CSRF_TOKEN_VALUE_HERE";
const CSRF_TOKEN_2 = "CfDJ8IjSH_mU-EpAg-FAKE_CSRF_TOKEN_2_VALUE";

// Email page HTML — form has NO action attribute (posts to same URL)
// Submit button has data-sitekey (hCaptcha) — this is what the real page looks like.
const EMAIL_PAGE_HTML = `<!DOCTYPE html>
<html lang="en-gb"><head><title>Welcome - SingleKey ID</title></head><body>
<form class="form" method="post">
  <input class="input__element" type="text" name="UserIdentifierInput.EmailInput.StringValue" value="">
  <input name="__RequestVerificationToken" type="hidden" value="${CSRF_TOKEN}" />
  <input type="hidden" name="credential" value="">
  <input type="hidden" name="returnPath" value="/en-gb/login?ReturnUrl=%2Freturn">
  <button class="button button--submit button--protected" data-sitekey="f8fe2d56-ad42-4f44-b9fe-5b30fcb0dd38" disabled="">Continue</button>
</form>
<form class="language-switch" method="post" action="/en-gb/language">
  <input name="__RequestVerificationToken" type="hidden" value="${CSRF_TOKEN}" />
</form>
</body></html>`;

// Email page returned when email was accepted but no captcha supplied —
// same structure but email is pre-filled in the input value.
const EMAIL_PAGE_CAPTCHA_BLOCK_HTML = EMAIL_PAGE_HTML.replace(
    'name="UserIdentifierInput.EmailInput.StringValue" value=""',
    'name="UserIdentifierInput.EmailInput.StringValue" value="user@example.com"',
);

// Password page HTML — form also has NO action attribute, contains PasswordInput
const PASSWORD_PAGE_HTML = `<!DOCTYPE html>
<html lang="en-gb"><head><title>Enter password - SingleKey ID</title></head><body>
<form class="form" method="post">
  <input class="input__element" type="password" name="Password.PasswordInput.StringValue" value="">
  <input name="__RequestVerificationToken" type="hidden" value="${CSRF_TOKEN_2}" />
  <input type="hidden" name="credential" value="">
  <input type="hidden" name="returnPath" value="/en-gb/login?Current=%5B%5D">
</form>
<form class="language-switch" method="post" action="/en-gb/language">
  <input name="__RequestVerificationToken" type="hidden" value="${CSRF_TOKEN_2}" />
</form>
</body></html>`;

// Password page returned when password is wrong — same form, possibly with error text
const WRONG_PASSWORD_HTML = PASSWORD_PAGE_HTML; // server returns same password page

const TOKEN_BODY = {
    access_token: "acc.jwt.here",
    refresh_token: "ref.jwt.here",
    expires_in: 300,
    refresh_expires_in: 86400,
    token_type: "Bearer",
    scope: "email offline_access profile openid",
};

// ── parseFormFields() ─────────────────────────────────────────────────────────

describe("parseFormFields()", () => {
    const BASE_URL = "https://singlekey-id.com/en-gb/login?ReturnUrl=foo";

    it("returns pageUrl as action when form has no action attribute", () => {
        const { action, csrf } = parseFormFields(EMAIL_PAGE_HTML, BASE_URL);
        expect(action).to.equal(BASE_URL);
        expect(csrf).to.equal(CSRF_TOKEN);
    });

    it("skips the language-switcher form and picks up the no-action login form", () => {
        // Language switcher is at the bottom — action="/en-gb/language"
        const { action } = parseFormFields(EMAIL_PAGE_HTML, BASE_URL);
        expect(action).not.to.include("/language");
    });

    it("resolves relative action URL against base URL", () => {
        const html = `<form method="post" action="/en-gb/login/confirm">
          <input name="__RequestVerificationToken" type="hidden" value="csrf123" /></form>`;
        const { action, csrf } = parseFormFields(html, "https://singlekey-id.com/en-gb/login");
        expect(action).to.equal("https://singlekey-id.com/en-gb/login/confirm");
        expect(csrf).to.equal("csrf123");
    });

    it("returns nulls when no form found in HTML", () => {
        const { action, csrf } = parseFormFields("<html><p>No form</p></html>", BASE_URL);
        expect(action).to.be.null;
        expect(csrf).to.be.null;
    });

    it("returns null csrf when CSRF token is absent", () => {
        const html = `<form method="post"><input type="text" name="foo" value="bar"></form>`;
        const { action, csrf } = parseFormFields(html, BASE_URL);
        expect(action).to.equal(BASE_URL);
        expect(csrf).to.be.null;
    });

    it("decodes &amp; entities in explicit action URL", () => {
        const html = `<form method="post" action="/login?a=1&amp;b=2">
          <input name="__RequestVerificationToken" type="hidden" value="tok" /></form>`;
        const { action } = parseFormFields(html, "https://example.com/login");
        expect(action).to.include("a=1&b=2");
    });
});

// ── extractFormAction() (backward-compat) ────────────────────────────────────

describe("extractFormAction()", () => {
    it("extracts action from Keycloak-style explicit action=", () => {
        const html = `<form id="kc-form-login" action="https://keycloak.example.com/login?session=abc" method="post">`;
        expect(extractFormAction(html)).to.equal("https://keycloak.example.com/login?session=abc");
    });

    it("decodes &amp; HTML entities in action URL", () => {
        const html = `<form action="https://example.com/auth?foo=1&amp;bar=2">`;
        expect(extractFormAction(html)).to.equal("https://example.com/auth?foo=1&bar=2");
    });

    it("returns null when no form tag in HTML", () => {
        expect(extractFormAction("<html><body>No form</body></html>")).to.be.null;
    });

    it("returns null for empty string", () => {
        expect(extractFormAction("")).to.be.null;
    });
});

// ── extractCodeFromLocation() ─────────────────────────────────────────────────

describe("extractCodeFromLocation()", () => {
    it("extracts code from a full redirect URL", () => {
        expect(extractCodeFromLocation(FAKE_CALLBACK_URL)).to.equal("AUTH_CODE_XYZ");
    });

    it("returns null when URL contains error param", () => {
        expect(extractCodeFromLocation("https://www.bosch.com/boschcam?error=access_denied")).to.be
            .null;
    });

    it("returns null when no code param in URL", () => {
        expect(extractCodeFromLocation("https://www.bosch.com/boschcam?state=only")).to.be.null;
    });

    it("returns null for MFA redirect URL (no code)", () => {
        expect(extractCodeFromLocation(FAKE_MFA_LOCATION)).to.be.null;
    });

    it("returns null for malformed URL", () => {
        expect(extractCodeFromLocation("not-a-url-at-all")).to.be.null;
    });
});

// ── detectCaptcha() ──────────────────────────────────────────────────────────

describe("detectCaptcha()", () => {
    it("detects data-sitekey (hCaptcha/reCAPTCHA marker)", () => {
        expect(detectCaptcha('<button data-sitekey="f8fe2d56-xxx">')).to.be.true;
    });

    it("detects h-captcha class", () => {
        expect(detectCaptcha('<div class="h-captcha" data-sitekey="xxx">')).to.be.true;
    });

    it("detects g-recaptcha class", () => {
        expect(detectCaptcha('<div class="g-recaptcha" data-sitekey="xxx">')).to.be.true;
    });

    it("returns false when no captcha markers present", () => {
        expect(detectCaptcha("<form><input type='password'></form>")).to.be.false;
    });
});

// ── detectMfa() ──────────────────────────────────────────────────────────────

describe("detectMfa()", () => {
    it("detects 'enter verification code' text", () => {
        expect(detectMfa("<p>Please enter verification code from your app</p>")).to.be.true;
    });

    it("detects 'two-factor' text", () => {
        expect(detectMfa("<h1>Two-factor authentication</h1>")).to.be.true;
    });

    it("detects 'authenticator app' text", () => {
        expect(detectMfa("Open your authenticator app to get the code")).to.be.true;
    });

    it("returns false for normal login pages", () => {
        expect(
            detectMfa(
                "<form><input type='password' name='Password.PasswordInput.StringValue'></form>",
            ),
        ).to.be.false;
    });
});

// ── loginWithCredentials() — 2-step flow ─────────────────────────────────────

describe("loginWithCredentials()", () => {
    let pkceSub: sinon.SinonStub;
    let authUrlSub: sinon.SinonStub;
    let exchangeSub: sinon.SinonStub;

    beforeEach(() => {
        pkceSub = sinon.stub(authModule, "generatePkcePair").returns(FAKE_PKCE);
        authUrlSub = sinon.stub(authModule, "buildAuthUrl").returns(FAKE_AUTH_URL);
        exchangeSub = sinon.stub(authModule, "exchangeCode");
    });

    afterEach(() => {
        sinon.restore();
        restoreAxios();
    });

    // ── Test 1: Happy path (2-step flow) ─────────────────────────────────────

    it("happy path: email page → password page → callback code → tokens", async () => {
        exchangeSub.resolves(TOKEN_BODY);

        // Stub the axios adapter to return a sequence of responses.
        // The stub intercepts axios.create() instances because wrapper(axios.create())
        // inherits axios.defaults.adapter.
        //
        // Sequence:
        //   1. GET auth URL → email page (200, no-action form)
        //   2. POST email  → password page (200, PasswordInput field)
        //   3. POST password → final callback URL (followed as redirect by maxRedirects:15)
        //
        // For the happy path the stub returns:
        //   1. email page HTML
        //   2. password page HTML
        //   3. 200 at callback URL (request.res.responseUrl = FAKE_CALLBACK_URL)
        //
        // Note: The 3rd call represents what happens after axios follows all redirects
        // and lands at FAKE_CALLBACK_URL. The stub sets responseUrl via request.res.
        stubAxiosSequence([
            // GET email page
            {
                status: 200,
                data: EMAIL_PAGE_HTML,
                headers: { "set-cookie": "SKI_session=sess123; Path=/; HttpOnly" },
                request: { res: { responseUrl: FAKE_EMAIL_PAGE_URL } },
            },
            // POST email → password page
            {
                status: 200,
                data: PASSWORD_PAGE_HTML,
                headers: {},
                request: { res: { responseUrl: FAKE_PASSWORD_PAGE_URL } },
            },
            // POST password → followed to callback URL
            {
                status: 200,
                data: "",
                headers: {},
                request: { res: { responseUrl: FAKE_CALLBACK_URL } },
            },
        ]);

        const result = await loginWithCredentials(
            axios.create(),
            "user@example.com",
            "correct-password",
        );

        expect(result.access_token).to.equal(TOKEN_BODY.access_token);
        expect(result.refresh_token).to.equal(TOKEN_BODY.refresh_token);
        expect(result.expires_in).to.equal(TOKEN_BODY.expires_in);
        expect(pkceSub.calledOnce).to.be.true;
        expect(authUrlSub.calledOnce).to.be.true;
        expect(exchangeSub.calledOnceWith(sinon.match.any, "AUTH_CODE_XYZ", FAKE_PKCE.verifier)).to
            .be.true;
    });

    // ── Test 2: hCaptcha blocks email → MfaRequiredError ─────────────────────

    it("throws MfaRequiredError when email page returns same page with captcha (email pre-filled)", async () => {
        // Server returns the email page again with the email value pre-filled
        // and data-sitekey present → hCaptcha required
        stubAxiosSequence([
            {
                status: 200,
                data: EMAIL_PAGE_HTML,
                headers: {},
                request: { res: { responseUrl: FAKE_EMAIL_PAGE_URL } },
            },
            {
                status: 200,
                data: EMAIL_PAGE_CAPTCHA_BLOCK_HTML,
                headers: {},
                request: { res: { responseUrl: FAKE_EMAIL_PAGE_URL } },
            },
        ]);

        try {
            await loginWithCredentials(axios.create(), "user@example.com", "any-password");
            expect.fail("should have thrown");
        } catch (err: unknown) {
            expect(err).to.be.instanceOf(MfaRequiredError);
            expect((err as MfaRequiredError).message).to.include("hCaptcha");
        }
    });

    // ── Test 3: Email not registered → bounces back (no pre-fill) → InvalidCredentialsError

    it("throws InvalidCredentialsError when email is not registered (email not pre-filled in response)", async () => {
        // Server returns email page but email field value is still empty (email not accepted)
        const notRegisteredHtml = EMAIL_PAGE_HTML; // email value="" — not pre-filled

        stubAxiosSequence([
            {
                status: 200,
                data: EMAIL_PAGE_HTML,
                headers: {},
                request: { res: { responseUrl: FAKE_EMAIL_PAGE_URL } },
            },
            {
                status: 200,
                data: notRegisteredHtml,
                headers: {},
                request: { res: { responseUrl: FAKE_EMAIL_PAGE_URL } },
            },
        ]);

        try {
            // Email that's not in the system
            await loginWithCredentials(axios.create(), "unknown@example.com", "any-password");
            expect.fail("should have thrown");
        } catch (err: unknown) {
            expect(err).to.be.instanceOf(InvalidCredentialsError);
            expect((err as InvalidCredentialsError).message).to.include("Email rejected");
        }
    });

    // ── Test 4: Wrong password → password page returned again → InvalidCredentialsError

    it("throws InvalidCredentialsError when password page is returned after password POST", async () => {
        exchangeSub.resolves(TOKEN_BODY);

        stubAxiosSequence([
            // GET email page
            {
                status: 200,
                data: EMAIL_PAGE_HTML,
                headers: {},
                request: { res: { responseUrl: FAKE_EMAIL_PAGE_URL } },
            },
            // POST email → password page (success: email accepted)
            {
                status: 200,
                data: PASSWORD_PAGE_HTML,
                headers: {},
                request: { res: { responseUrl: FAKE_PASSWORD_PAGE_URL } },
            },
            // POST password → same password page returned (wrong password)
            {
                status: 200,
                data: WRONG_PASSWORD_HTML, // still contains PasswordInput
                headers: {},
                request: { res: { responseUrl: FAKE_PASSWORD_PAGE_URL } },
            },
        ]);

        try {
            await loginWithCredentials(axios.create(), "user@example.com", "wrong-password");
            expect.fail("should have thrown");
        } catch (err: unknown) {
            expect(err).to.be.instanceOf(InvalidCredentialsError);
            expect((err as InvalidCredentialsError).name).to.equal("InvalidCredentialsError");
        }
    });

    // ── Test 5: MFA detected on password page → MfaRequiredError

    it("throws MfaRequiredError when MFA challenge appears after email POST", async () => {
        const mfaHtml = `<html><head><title>Two-factor authentication</title></head>
<body><p>Enter verification code from your authenticator app</p></body></html>`;

        stubAxiosSequence([
            {
                status: 200,
                data: EMAIL_PAGE_HTML,
                headers: {},
                request: { res: { responseUrl: FAKE_EMAIL_PAGE_URL } },
            },
            {
                status: 200,
                data: mfaHtml,
                headers: {},
                request: { res: { responseUrl: "https://singlekey-id.com/en-gb/mfa" } },
            },
        ]);

        try {
            await loginWithCredentials(axios.create(), "user@example.com", "secret");
            expect.fail("should have thrown");
        } catch (err: unknown) {
            expect(err).to.be.instanceOf(MfaRequiredError);
            expect((err as MfaRequiredError).name).to.equal("MfaRequiredError");
        }
    });

    // ── Test 6: CAPTCHA on email page when email field is empty (not captcha-block) ──

    it("throws LoginFlowError when email page has no CSRF token", async () => {
        const noCsrfHtml = `<html><body><form class="form" method="post">
<input type="text" name="UserIdentifierInput.EmailInput.StringValue" value="">
</form></body></html>`;

        stubAxiosSequence([
            {
                status: 200,
                data: noCsrfHtml,
                headers: {},
                request: { res: { responseUrl: FAKE_EMAIL_PAGE_URL } },
            },
        ]);

        try {
            await loginWithCredentials(axios.create(), "user@example.com", "secret");
            expect.fail("should have thrown");
        } catch (err: unknown) {
            expect(err).to.be.instanceOf(LoginFlowError);
            expect((err as LoginFlowError).message).to.include("CSRF");
        }
    });

    // ── Test 7: Password page has no CSRF → LoginFlowError

    it("throws LoginFlowError when password page has no CSRF token", async () => {
        const noCsrfPasswordHtml = `<html><body><form class="form" method="post">
<input type="password" name="Password.PasswordInput.StringValue" value="">
</form></body></html>`;

        stubAxiosSequence([
            {
                status: 200,
                data: EMAIL_PAGE_HTML,
                headers: {},
                request: { res: { responseUrl: FAKE_EMAIL_PAGE_URL } },
            },
            {
                status: 200,
                data: noCsrfPasswordHtml,
                headers: {},
                request: { res: { responseUrl: FAKE_PASSWORD_PAGE_URL } },
            },
        ]);

        try {
            await loginWithCredentials(axios.create(), "user@example.com", "secret");
            expect.fail("should have thrown");
        } catch (err: unknown) {
            expect(err).to.be.instanceOf(LoginFlowError);
            expect((err as LoginFlowError).message).to.include("CSRF");
        }
    });

    // ── Test 8: 5xx on GET auth page → LoginFlowError

    it("throws LoginFlowError on 5xx from auth server during GET", async () => {
        stubAxiosError(503, "Service Unavailable");

        try {
            await loginWithCredentials(axios.create(), "user@example.com", "secret");
            expect.fail("should have thrown");
        } catch (err: unknown) {
            expect(err).to.be.instanceOf(LoginFlowError);
            expect((err as LoginFlowError).message).to.include("503");
        }
    });

    // ── Test 9: Network error during GET → LoginFlowError

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
        } finally {
            axios.defaults.adapter = savedAdapter as typeof axios.defaults.adapter;
        }
    });

    // ── Test 10: 400 from GET auth page → LoginFlowError

    it("throws LoginFlowError with HTTP 400 detail when auth page returns 400", async () => {
        const savedAdapter = axios.defaults.adapter;
        axios.defaults.adapter = (_config): Promise<never> => {
            const err: Error & {
                response?: { status: number; data: unknown; headers: Record<string, string> };
                isAxiosError?: boolean;
            } = new Error("Request failed with status code 400");
            err.response = {
                status: 400,
                data: { error: "Restart login cookie not found. It may have expired." },
                headers: {},
            };
            err.isAxiosError = true;
            return Promise.reject(err);
        };

        try {
            await loginWithCredentials(axios.create(), "user@example.com", "secret");
            expect.fail("should have thrown");
        } catch (err: unknown) {
            expect(err).to.be.instanceOf(LoginFlowError);
            expect((err as LoginFlowError).message).to.include("400");
        } finally {
            axios.defaults.adapter = savedAdapter as typeof axios.defaults.adapter;
        }
    });

    // ── Test 11: No auth code in final URL → LoginFlowError

    it("throws LoginFlowError when no code in final redirect URL", async () => {
        exchangeSub.resolves(TOKEN_BODY);

        stubAxiosSequence([
            {
                status: 200,
                data: EMAIL_PAGE_HTML,
                headers: {},
                request: { res: { responseUrl: FAKE_EMAIL_PAGE_URL } },
            },
            {
                status: 200,
                data: PASSWORD_PAGE_HTML,
                headers: {},
                request: { res: { responseUrl: FAKE_PASSWORD_PAGE_URL } },
            },
            // Callback URL has no code (e.g. error page)
            {
                status: 200,
                data: "",
                headers: {},
                request: { res: { responseUrl: "https://www.bosch.com/boschcam?state=only" } },
            },
        ]);

        try {
            await loginWithCredentials(axios.create(), "user@example.com", "secret");
            expect.fail("should have thrown");
        } catch (err: unknown) {
            expect(err).to.be.instanceOf(LoginFlowError);
            expect((err as LoginFlowError).message).to.include("No auth code");
        }
    });

    // ── Test 12: MFA redirect after password POST (code absent, mfa in URL)

    it("throws MfaRequiredError when final URL after password POST contains mfa path", async () => {
        exchangeSub.resolves(TOKEN_BODY);

        stubAxiosSequence([
            {
                status: 200,
                data: EMAIL_PAGE_HTML,
                headers: {},
                request: { res: { responseUrl: FAKE_EMAIL_PAGE_URL } },
            },
            {
                status: 200,
                data: PASSWORD_PAGE_HTML,
                headers: {},
                request: { res: { responseUrl: FAKE_PASSWORD_PAGE_URL } },
            },
            {
                status: 200,
                data: "",
                headers: {},
                request: { res: { responseUrl: FAKE_MFA_LOCATION } },
            },
        ]);

        try {
            await loginWithCredentials(axios.create(), "user@example.com", "secret");
            expect.fail("should have thrown");
        } catch (err: unknown) {
            expect(err).to.be.instanceOf(MfaRequiredError);
        }
    });

    // ── Test 13: exchangeCode throws RefreshTokenInvalidError → bubbles up

    it("bubbles up RefreshTokenInvalidError from exchangeCode", async () => {
        exchangeSub.rejects(new RefreshTokenInvalidError("Token exchange: HTTP 400 invalid_grant"));

        stubAxiosSequence([
            {
                status: 200,
                data: EMAIL_PAGE_HTML,
                headers: {},
                request: { res: { responseUrl: FAKE_EMAIL_PAGE_URL } },
            },
            {
                status: 200,
                data: PASSWORD_PAGE_HTML,
                headers: {},
                request: { res: { responseUrl: FAKE_PASSWORD_PAGE_URL } },
            },
            {
                status: 200,
                data: "",
                headers: {},
                request: { res: { responseUrl: FAKE_CALLBACK_URL } },
            },
        ]);

        try {
            await loginWithCredentials(axios.create(), "user@example.com", "secret");
            expect.fail("should have thrown");
        } catch (err: unknown) {
            expect(err).to.be.instanceOf(RefreshTokenInvalidError);
        }
    });

    // ── Test 14: exchangeCode returns null → LoginFlowError

    it("throws LoginFlowError when exchangeCode returns null (transient network error)", async () => {
        exchangeSub.resolves(null);

        stubAxiosSequence([
            {
                status: 200,
                data: EMAIL_PAGE_HTML,
                headers: {},
                request: { res: { responseUrl: FAKE_EMAIL_PAGE_URL } },
            },
            {
                status: 200,
                data: PASSWORD_PAGE_HTML,
                headers: {},
                request: { res: { responseUrl: FAKE_PASSWORD_PAGE_URL } },
            },
            {
                status: 200,
                data: "",
                headers: {},
                request: { res: { responseUrl: FAKE_CALLBACK_URL } },
            },
        ]);

        try {
            await loginWithCredentials(axios.create(), "user@example.com", "secret");
            expect.fail("should have thrown");
        } catch (err: unknown) {
            expect(err).to.be.instanceOf(LoginFlowError);
            expect((err as LoginFlowError).message).to.include("null");
        }
    });

    // ── Test 15: 5xx on email POST → LoginFlowError

    it("throws LoginFlowError on 5xx during email POST", async () => {
        stubAxiosSequence([
            {
                status: 200,
                data: EMAIL_PAGE_HTML,
                headers: {},
                request: { res: { responseUrl: FAKE_EMAIL_PAGE_URL } },
            },
            { status: 500, data: "Internal Server Error", headers: {} },
        ]);

        try {
            await loginWithCredentials(axios.create(), "user@example.com", "secret");
            expect.fail("should have thrown");
        } catch (err: unknown) {
            expect(err).to.be.instanceOf(LoginFlowError);
        }
    });

    // ── Test 16: Cookie jar - session cookie from email page relayed to POST

    it("succeeds when session cookies are set on email page (jar relays them to POST)", async () => {
        exchangeSub.resolves(TOKEN_BODY);

        stubAxiosSequence([
            {
                status: 200,
                data: EMAIL_PAGE_HTML,
                headers: {
                    "set-cookie": [
                        ".AspNetCore.Antiforgery.xyz=token123; Path=/; HttpOnly",
                        "SKI_session=sess42; Path=/; HttpOnly",
                    ],
                },
                request: { res: { responseUrl: FAKE_EMAIL_PAGE_URL } },
            },
            {
                status: 200,
                data: PASSWORD_PAGE_HTML,
                headers: {},
                request: { res: { responseUrl: FAKE_PASSWORD_PAGE_URL } },
            },
            {
                status: 200,
                data: "",
                headers: {},
                request: { res: { responseUrl: FAKE_CALLBACK_URL } },
            },
        ]);

        const result = await loginWithCredentials(axios.create(), "user@example.com", "secret");
        expect(result.access_token).to.equal(TOKEN_BODY.access_token);
    });
});
