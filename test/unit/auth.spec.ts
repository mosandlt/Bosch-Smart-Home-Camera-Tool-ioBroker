/**
 * Unit tests for src/lib/auth.ts
 *
 * Covers:
 *   - generatePkcePair()      — PKCE verifier/challenge correctness
 *   - buildAuthUrl()          — URL shape and required query params
 *   - extractCode()           — null-safety on all edge cases
 *   - exchangeCode()          — HTTP error classification + happy path
 *   - refreshAccessToken()    — HTTP error classification + happy path
 *   - detectTokenClientId()   — JWT parsing, malformed inputs, null safety
 *
 * Framework: Mocha + Chai (no Sinon needed — axios-mock helpers suffice)
 * Mocking:   test/unit/helpers/axios-mock.ts (stubAxiosSequence / stubAxiosError / restoreAxios)
 */

import { expect } from "chai";
import * as crypto from "crypto";
import axios from "axios";

import {
    generatePkcePair,
    buildAuthUrl,
    extractCode,
    exchangeCode,
    refreshAccessToken,
    detectTokenClientId,
    RefreshTokenInvalidError,
    AuthServerOutageError,
    KEYCLOAK_BASE,
    CLIENT_ID,
    REDIRECT_URI,
    SCOPES,
} from "../../src/lib/auth";

import { stubAxiosSequence, stubAxiosError, restoreAxios } from "./helpers/axios-mock";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal valid TokenResult response body */
const TOKEN_BODY = {
    access_token: "acc.token.here",
    refresh_token: "ref.token.here",
    expires_in: 300,
    refresh_expires_in: 86400,
    token_type: "Bearer",
    scope: "email offline_access profile openid",
};

/** Build a base64url-encoded JWT payload for detectTokenClientId tests */
function makeJwt(payload: Record<string, unknown>): string {
    const header = Buffer.from('{"alg":"RS256","typ":"JWT"}').toString("base64url");
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const sig = "fakesig";
    return `${header}.${body}.${sig}`;
}

// ---------------------------------------------------------------------------
// 1. generatePkcePair()
// ---------------------------------------------------------------------------

describe("generatePkcePair()", () => {
    it("returns verifier and challenge that are both non-empty strings", () => {
        const { verifier, challenge } = generatePkcePair();
        expect(verifier).to.be.a("string").and.have.length.greaterThan(0);
        expect(challenge).to.be.a("string").and.have.length.greaterThan(0);
    });

    it("verifier is base64url (no +, /, or = chars)", () => {
        const { verifier } = generatePkcePair();
        expect(verifier).to.match(/^[A-Za-z0-9_-]+$/);
    });

    it("challenge is base64url (no +, /, or = chars)", () => {
        const { challenge } = generatePkcePair();
        expect(challenge).to.match(/^[A-Za-z0-9_-]+$/);
    });

    it("verifier is 86 chars long (64 raw bytes → base64url)", () => {
        const { verifier } = generatePkcePair();
        expect(verifier).to.have.lengthOf(86);
    });

    it("challenge is 43 chars long (32 SHA-256 bytes → base64url)", () => {
        const { challenge } = generatePkcePair();
        expect(challenge).to.have.lengthOf(43);
    });

    it("challenge equals SHA-256(verifier) encoded as base64url", () => {
        const { verifier, challenge } = generatePkcePair();
        const expected = crypto.createHash("sha256").update(verifier).digest("base64url");
        expect(challenge).to.equal(expected);
    });

    it("two consecutive calls return different pairs (random)", () => {
        const a = generatePkcePair();
        const b = generatePkcePair();
        expect(a.verifier).to.not.equal(b.verifier);
        expect(a.challenge).to.not.equal(b.challenge);
    });
});

// ---------------------------------------------------------------------------
// 2. buildAuthUrl()
// ---------------------------------------------------------------------------

describe("buildAuthUrl()", () => {
    const challenge = "testchallenge_abc123";
    const state = "random-state-xyz";
    let url: string;
    let params: URLSearchParams;

    before(() => {
        url = buildAuthUrl(challenge, state);
        params = new URL(url).searchParams;
    });

    it("returns a URL starting with KEYCLOAK_BASE + /auth?", () => {
        expect(url).to.match(
            new RegExp(`^${KEYCLOAK_BASE.replace(/\./g, "\\.").replace(/\//g, "\\/")}\/auth\\?`),
        );
    });

    it("contains client_id = CLIENT_ID", () => {
        expect(params.get("client_id")).to.equal(CLIENT_ID);
    });

    it("contains redirect_uri = REDIRECT_URI", () => {
        expect(params.get("redirect_uri")).to.equal(REDIRECT_URI);
    });

    it("contains scope = SCOPES", () => {
        expect(params.get("scope")).to.equal(SCOPES);
    });

    it("contains code_challenge = passed challenge", () => {
        expect(params.get("code_challenge")).to.equal(challenge);
    });

    it("contains code_challenge_method = S256", () => {
        expect(params.get("code_challenge_method")).to.equal("S256");
    });

    it("contains state = passed state", () => {
        expect(params.get("state")).to.equal(state);
    });

    it("contains response_type = code", () => {
        expect(params.get("response_type")).to.equal("code");
    });
});

// ---------------------------------------------------------------------------
// 3. extractCode()
// ---------------------------------------------------------------------------

describe("extractCode()", () => {
    it("extracts code from a valid full redirect URL", () => {
        const result = extractCode("https://www.bosch.com/boschcam?code=ABC123&state=xyz");
        expect(result).to.equal("ABC123");
    });

    it("returns null (no throw) when ?error= is present", () => {
        const result = extractCode(
            "https://www.bosch.com/boschcam?error=access_denied&error_description=user+cancelled",
        );
        expect(result).to.be.null;
    });

    it("returns null when no code param in URL", () => {
        const result = extractCode("https://www.bosch.com/boschcam?state=only");
        expect(result).to.be.null;
    });

    it("returns null (no throw) for a malformed URL string", () => {
        const result = extractCode("not a url at all !! $$");
        expect(result).to.be.null;
    });

    it("returns null (no throw) for empty string", () => {
        const result = extractCode("");
        expect(result).to.be.null;
    });

    it("extracts code from bare query string without scheme", () => {
        // User might paste just the query part
        const result = extractCode("code=QSAUTH&state=somestate");
        expect(result).to.equal("QSAUTH");
    });

    it("returns null when URL has code= but also error=", () => {
        // error takes precedence
        const result = extractCode("https://host/?error=server_error&code=XYZ");
        expect(result).to.be.null;
    });
});

// ---------------------------------------------------------------------------
// 4. refreshAccessToken() — error classification (CRITICAL)
// ---------------------------------------------------------------------------

describe("refreshAccessToken() error classification", () => {
    afterEach(() => {
        restoreAxios();
    });

    it("throws RefreshTokenInvalidError on HTTP 400", async () => {
        stubAxiosError(400, { error: "invalid_grant" });
        try {
            await refreshAccessToken(axios.create(), "stale-token");
            expect.fail("should have thrown");
        } catch (err: unknown) {
            expect(err).to.be.instanceOf(RefreshTokenInvalidError);
            expect((err as RefreshTokenInvalidError).name).to.equal("RefreshTokenInvalidError");
        }
    });

    it("throws RefreshTokenInvalidError on HTTP 401", async () => {
        stubAxiosError(401, { error: "unauthorized_client" });
        try {
            await refreshAccessToken(axios.create(), "expired-token");
            expect.fail("should have thrown");
        } catch (err: unknown) {
            expect(err).to.be.instanceOf(RefreshTokenInvalidError);
        }
    });

    it("throws AuthServerOutageError on HTTP 500", async () => {
        stubAxiosError(500, "Internal Server Error");
        try {
            await refreshAccessToken(axios.create(), "valid-token");
            expect.fail("should have thrown");
        } catch (err: unknown) {
            expect(err).to.be.instanceOf(AuthServerOutageError);
            expect((err as AuthServerOutageError).name).to.equal("AuthServerOutageError");
        }
    });

    it("throws AuthServerOutageError on HTTP 503", async () => {
        stubAxiosError(503, "Service Unavailable");
        try {
            await refreshAccessToken(axios.create(), "valid-token");
            expect.fail("should have thrown");
        } catch (err: unknown) {
            expect(err).to.be.instanceOf(AuthServerOutageError);
        }
    });

    it("returns null on network/timeout error (no response)", async () => {
        // Network error: isAxiosError=true but no response property
        const savedAdapter = axios.defaults.adapter;
        axios.defaults.adapter = (): Promise<never> => {
            const err = Object.assign(new Error("ECONNREFUSED"), {
                isAxiosError: true,
                // no .response — pure network failure
            });
            return Promise.reject(err);
        };
        try {
            const result = await refreshAccessToken(axios.create(), "token");
            expect(result).to.be.null;
        } finally {
            axios.defaults.adapter = savedAdapter as typeof axios.defaults.adapter;
        }
    });

    it("returns TokenResult on 200 success", async () => {
        stubAxiosSequence([{ status: 200, data: TOKEN_BODY }]);
        const result = await refreshAccessToken(axios.create(), "good-refresh-token");
        expect(result).to.not.be.null;
        expect(result!.access_token).to.equal(TOKEN_BODY.access_token);
        expect(result!.refresh_token).to.equal(TOKEN_BODY.refresh_token);
        expect(result!.expires_in).to.equal(TOKEN_BODY.expires_in);
        expect(result!.token_type).to.equal(TOKEN_BODY.token_type);
    });

    it("does NOT throw RefreshTokenInvalidError on 5xx (preserves token)", async () => {
        stubAxiosError(502, "Bad Gateway");
        try {
            await refreshAccessToken(axios.create(), "valid-token");
            expect.fail("should have thrown");
        } catch (err: unknown) {
            // Must NOT be RefreshTokenInvalidError — that would trigger a spurious re-login
            expect(err).to.not.be.instanceOf(RefreshTokenInvalidError);
            expect(err).to.be.instanceOf(AuthServerOutageError);
        }
    });
});

// ---------------------------------------------------------------------------
// 5. exchangeCode() — error classification + happy path
// ---------------------------------------------------------------------------

describe("exchangeCode()", () => {
    afterEach(() => {
        restoreAxios();
    });

    it("returns parsed TokenResult on 200 success", async () => {
        stubAxiosSequence([{ status: 200, data: TOKEN_BODY }]);
        const result = await exchangeCode(axios.create(), "auth-code-abc", "verifier-xyz");
        expect(result).to.not.be.null;
        expect(result!.access_token).to.equal(TOKEN_BODY.access_token);
        expect(result!.refresh_token).to.equal(TOKEN_BODY.refresh_token);
        expect(result!.expires_in).to.equal(TOKEN_BODY.expires_in);
        expect(result!.refresh_expires_in).to.equal(TOKEN_BODY.refresh_expires_in);
        expect(result!.scope).to.equal(TOKEN_BODY.scope);
    });

    it("defaults refresh_expires_in to 0 when missing from response", async () => {
        const bodyWithoutRefreshExpiry = { ...TOKEN_BODY, refresh_expires_in: undefined };
        stubAxiosSequence([{ status: 200, data: bodyWithoutRefreshExpiry }]);
        const result = await exchangeCode(axios.create(), "code", "verifier");
        expect(result!.refresh_expires_in).to.equal(0);
    });

    it("throws RefreshTokenInvalidError on HTTP 400", async () => {
        stubAxiosError(400, { error: "invalid_grant" });
        try {
            await exchangeCode(axios.create(), "bad-code", "verifier");
            expect.fail("should have thrown");
        } catch (err: unknown) {
            expect(err).to.be.instanceOf(RefreshTokenInvalidError);
        }
    });

    it("throws RefreshTokenInvalidError on HTTP 401", async () => {
        stubAxiosError(401, { error: "invalid_client" });
        try {
            await exchangeCode(axios.create(), "code", "verifier");
            expect.fail("should have thrown");
        } catch (err: unknown) {
            expect(err).to.be.instanceOf(RefreshTokenInvalidError);
        }
    });

    it("throws AuthServerOutageError on HTTP 500", async () => {
        stubAxiosError(500, "Internal Server Error");
        try {
            await exchangeCode(axios.create(), "code", "verifier");
            expect.fail("should have thrown");
        } catch (err: unknown) {
            expect(err).to.be.instanceOf(AuthServerOutageError);
        }
    });

    it("throws AuthServerOutageError on HTTP 503", async () => {
        stubAxiosError(503, "Service Unavailable");
        try {
            await exchangeCode(axios.create(), "code", "verifier");
            expect.fail("should have thrown");
        } catch (err: unknown) {
            expect(err).to.be.instanceOf(AuthServerOutageError);
        }
    });

    it("returns null on network error (isAxiosError, no response)", async () => {
        const savedAdapter = axios.defaults.adapter;
        axios.defaults.adapter = (): Promise<never> => {
            const err = Object.assign(new Error("ETIMEDOUT"), { isAxiosError: true });
            return Promise.reject(err);
        };
        try {
            const result = await exchangeCode(axios.create(), "code", "verifier");
            expect(result).to.be.null;
        } finally {
            axios.defaults.adapter = savedAdapter as typeof axios.defaults.adapter;
        }
    });
});

// ---------------------------------------------------------------------------
// 6. detectTokenClientId()
// ---------------------------------------------------------------------------

describe("detectTokenClientId()", () => {
    it("extracts azp claim from a valid JWT", () => {
        const token = makeJwt({ azp: "oss_residential_app", sub: "user-123" });
        expect(detectTokenClientId(token)).to.equal("oss_residential_app");
    });

    it("returns null when JWT has no azp claim", () => {
        const token = makeJwt({ sub: "user-123", iss: "keycloak" });
        expect(detectTokenClientId(token)).to.be.null;
    });

    it("returns null for malformed JWT (only 1 part, no dots)", () => {
        expect(detectTokenClientId("notajwt")).to.be.null;
    });

    it("returns null for malformed JWT (2 parts instead of 3)", () => {
        expect(detectTokenClientId("header.payload")).to.be.null;
    });

    it("returns null for empty string (no throw)", () => {
        expect(detectTokenClientId("")).to.be.null;
    });

    it("returns null when payload is not valid JSON base64url", () => {
        // Third segment is the signature — provide garbage in the payload slot
        expect(detectTokenClientId("header.!!!notbase64!!!.sig")).to.be.null;
    });

    it("returns string even when azp is a number (coerced to string)", () => {
        const token = makeJwt({ azp: 42 });
        expect(detectTokenClientId(token)).to.equal("42");
    });

    it("returns null when payload is valid JSON but azp is null", () => {
        const token = makeJwt({ azp: null, sub: "user" });
        expect(detectTokenClientId(token)).to.be.null;
    });
});
