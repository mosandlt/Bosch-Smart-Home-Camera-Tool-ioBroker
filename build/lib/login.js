"use strict";
/**
 * Programmatic OAuth2 Login for Bosch SingleKey ID (Keycloak)
 *
 * Implements the end-to-end username/password login flow without browser interaction.
 *
 * Flow:
 *   1. generatePkcePair() + buildAuthUrl()
 *   2. GET auth URL → Keycloak returns HTML login form with action= URL
 *   3. Extract form action URL from HTML (regex match on <form ...action="...">)
 *   4. POST username + password to form action URL (with session cookie)
 *      - Keycloak 302 redirect to REDIRECT_URI?code=... → success
 *      - Keycloak 302 to MFA page (no code param) → MfaRequiredError
 *      - Keycloak 200 (HTML with error msg, no redirect) → InvalidCredentialsError
 *   5. Extract code from Location header
 *   6. exchangeCode() → TokenResult
 *
 * Cookie handling:
 *   Keycloak sets a session cookie (KC_RESTART / AUTH_SESSION_ID) on the GET.
 *   This cookie must be sent back with the POST — otherwise Keycloak rejects the
 *   request. We extract Set-Cookie headers from the GET response and relay them.
 *
 * References:
 *   Python CLI get_token.py: _pkce_pair, _build_auth_url, _exchange_code
 *   HA config_flow.py: _build_auth_url, _extract_code, _exchange_code
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.LoginFlowError = exports.MfaRequiredError = exports.InvalidCredentialsError = void 0;
exports.extractFormAction = extractFormAction;
exports.extractCodeFromLocation = extractCodeFromLocation;
exports.loginWithCredentials = loginWithCredentials;
const axios_1 = __importDefault(require("axios"));
const auth_1 = require("./auth");
const crypto = __importStar(require("crypto"));
// ── Error classes ─────────────────────────────────────────────────────────────
/** Thrown when Keycloak rejects username/password (200 response with error HTML, no redirect). */
class InvalidCredentialsError extends Error {
    constructor(message = "Invalid credentials") {
        super(message);
        this.name = "InvalidCredentialsError";
    }
}
exports.InvalidCredentialsError = InvalidCredentialsError;
/** Thrown when Keycloak demands an MFA / interactive step (302 to a page without a code). */
class MfaRequiredError extends Error {
    constructor(message = "MFA or additional verification required") {
        super(message);
        this.name = "MfaRequiredError";
    }
}
exports.MfaRequiredError = MfaRequiredError;
/** Thrown when the login flow fails for non-credential reasons (5xx, network, parsing errors). */
class LoginFlowError extends Error {
    constructor(message) {
        super(message);
        this.name = "LoginFlowError";
    }
}
exports.LoginFlowError = LoginFlowError;
// ── Helpers ───────────────────────────────────────────────────────────────────
/**
 * Extract the Keycloak login form action URL from the auth page HTML.
 *
 * Keycloak renders a <form ... action="https://..."> on its login page.
 * The action URL is the direct POST endpoint for username/password.
 *
 * @param html  Raw HTML of the Keycloak login page
 * @returns The action URL, or null if not found
 */
function extractFormAction(html) {
    // Match <form ... action="<url>"> — Keycloak may have extra attributes before action
    // and the URL may contain HTML entities like &amp; which we must decode.
    const match = html.match(/<form[^>]+action="([^"]+)"/i);
    if (!match) {
        return null;
    }
    // Decode HTML entities (&amp; → &, etc.)
    return match[1]
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
}
/**
 * Extract the authorization code from a redirect Location header.
 *
 * @param location  The Location header value from a 302 response
 * @returns The code query parameter, or null if not present
 */
function extractCodeFromLocation(location) {
    try {
        // Location may be a full URL or a relative path — handle both
        const url = location.startsWith("http")
            ? new URL(location)
            : new URL(`https://placeholder.invalid${location.startsWith("/") ? "" : "/"}${location}`);
        if (url.searchParams.get("error")) {
            return null;
        }
        return url.searchParams.get("code");
    }
    catch {
        return null;
    }
}
/**
 * Build a cookie header string from a Set-Cookie response header value.
 * Extracts only the name=value pairs, discarding Path/HttpOnly/Secure directives.
 *
 * @param setCookieHeaders  Array of Set-Cookie header strings
 * @returns Cookie header value suitable for the next request
 */
function buildCookieHeader(setCookieHeaders) {
    if (!setCookieHeaders)
        return "";
    const headers = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
    return headers
        .map((h) => h.split(";")[0].trim()) // keep only name=value, strip directives
        .filter(Boolean)
        .join("; ");
}
// ── Main export ───────────────────────────────────────────────────────────────
/**
 * End-to-end programmatic OAuth login for Bosch SingleKey ID (Keycloak).
 *
 * Requires no browser. Submits username + password directly to the Keycloak
 * login form and captures the auth code from the redirect Location header.
 *
 * @param httpClient  Axios instance (injected for testability)
 * @param username    Bosch SingleKey ID email address
 * @param password    Bosch SingleKey ID password
 * @returns TokenResult (access_token, refresh_token, ...) on success
 * @throws InvalidCredentialsError  — wrong username or password
 * @throws MfaRequiredError         — account requires MFA / additional verification
 * @throws LoginFlowError           — network errors, server errors, parsing failures
 */
async function loginWithCredentials(httpClient, username, password) {
    // Step 1: Generate PKCE pair and build auth URL
    const { verifier, challenge } = (0, auth_1.generatePkcePair)();
    const state = crypto.randomBytes(16).toString("base64url");
    const authUrl = (0, auth_1.buildAuthUrl)(challenge, state);
    // Step 2: GET auth URL → HTML login form
    let getRespData;
    let getRespCookies;
    try {
        const getResp = await httpClient.get(authUrl, {
            maxRedirects: 5, // follow Keycloak's own internal redirects (session init)
            headers: { Accept: "text/html" },
            responseType: "text",
        });
        if (getResp.status >= 500) {
            throw new LoginFlowError(`Keycloak GET auth page HTTP ${getResp.status}`);
        }
        getRespData = getResp.data;
        // axios normalizes headers to AxiosResponseHeaders; read set-cookie directly
        getRespCookies = getResp.headers["set-cookie"];
    }
    catch (err) {
        if (err instanceof LoginFlowError)
            throw err;
        if (axios_1.default.isAxiosError(err)) {
            const status = err.response?.status;
            if (status !== undefined && status >= 500) {
                throw new LoginFlowError(`Keycloak GET auth page HTTP ${status}`);
            }
            throw new LoginFlowError(`Network error fetching auth page: ${err.message}`);
        }
        throw new LoginFlowError(`Unexpected error fetching auth page: ${String(err)}`);
    }
    // Step 3: Extract form action URL from HTML
    const formAction = extractFormAction(getRespData);
    if (!formAction) {
        throw new LoginFlowError("Could not find login form action URL in Keycloak response");
    }
    // Collect session cookies from GET response (required for POST)
    const cookieHeader = buildCookieHeader(getRespCookies);
    // Step 4: POST username + password to form action URL
    const formBody = new URLSearchParams({
        username,
        password,
    });
    let postStatus;
    let postLocation;
    try {
        const postResp = await httpClient.post(formAction, formBody.toString(), {
            maxRedirects: 0, // do NOT follow — we need to inspect the 302 Location
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                "Accept": "text/html,application/xhtml+xml",
                ...(cookieHeader ? { Cookie: cookieHeader } : {}),
            },
            responseType: "text",
            validateStatus: (s) => s < 600, // accept any status to inspect it ourselves
        });
        postStatus = postResp.status;
        postLocation = postResp.headers["location"];
        // If status 200 with HTML: wrong password (Keycloak shows an error page instead of redirecting)
        if (postStatus === 200) {
            throw new InvalidCredentialsError("Username or password is incorrect");
        }
        // 5xx from POST → server outage
        if (postStatus >= 500) {
            throw new LoginFlowError(`Keycloak POST HTTP ${postStatus}`);
        }
    }
    catch (err) {
        // Re-throw our own typed errors (InvalidCredentialsError, LoginFlowError)
        if (err instanceof InvalidCredentialsError || err instanceof LoginFlowError) {
            throw err;
        }
        if (axios_1.default.isAxiosError(err)) {
            // axios throws on non-2xx when validateStatus is not set — but we set it above.
            // This path is only reached for network/timeout errors.
            throw new LoginFlowError(`Network error during credentials POST: ${err.message}`);
        }
        throw new LoginFlowError(`Unexpected error during credentials POST: ${String(err)}`);
    }
    // Step 5: Extract auth code from redirect Location
    if (!postLocation) {
        throw new LoginFlowError("No Location header in Keycloak POST response");
    }
    const code = extractCodeFromLocation(postLocation);
    if (!code) {
        // 302 but no code param → MFA page or unknown challenge
        throw new MfaRequiredError(`Keycloak redirected without auth code (Location: ${postLocation.substring(0, 120)})`);
    }
    // Step 6: Exchange code for tokens
    const tokens = await (0, auth_1.exchangeCode)(httpClient, code, verifier);
    if (!tokens) {
        throw new LoginFlowError("Token exchange returned null (transient network error)");
    }
    return tokens;
}
//# sourceMappingURL=login.js.map