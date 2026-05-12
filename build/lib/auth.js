"use strict";
/**
 * Bosch OAuth2 PKCE Authentication
 *
 * Port of the Python config_flow.py OAuth2 implementation to TypeScript.
 *
 * Flow overview (from Python reference):
 *   Issuer:       https://smarthome.authz.bosch.com/auth/realms/home_auth_provider
 *   Client ID:    oss_residential_app
 *   Client Secret: decoded from base64 "RjFqWnpzRzVOdHc3eDJWVmM4SjZxZ3NuaXNNT2ZhWmc="
 *   Scopes:       email offline_access profile openid
 *   Redirect URI: https://my.home-assistant.io/redirect/oauth (HA flow)
 *                 https://www.bosch.com/boschcam (manual/ioBroker flow)
 *
 * PKCE (RFC 7636):
 *   code_verifier  = crypto.randomBytes(64).toString('base64url')
 *   code_challenge = base64url(sha256(verifier))  [S256 method]
 *
 * Token exchange:
 *   POST {KEYCLOAK_BASE}/token
 *   body: client_id, client_secret, grant_type=authorization_code,
 *         code, redirect_uri, code_verifier
 *
 * Token refresh:
 *   POST {KEYCLOAK_BASE}/token
 *   body: client_id, client_secret, grant_type=refresh_token, refresh_token
 *
 * Error handling:
 *   HTTP 400/401 → RefreshTokenInvalidError (non-recoverable, need re-login)
 *   HTTP 5xx     → AuthServerOutageError (retry later, do NOT force re-login)
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
exports.crypto = exports.AuthServerOutageError = exports.RefreshTokenInvalidError = exports.CLOUD_API = exports.REDIRECT_URI = exports.SCOPES = exports.CLIENT_SECRET = exports.CLIENT_ID = exports.KEYCLOAK_BASE = void 0;
exports.generatePkcePair = generatePkcePair;
exports.buildAuthUrl = buildAuthUrl;
exports.extractCode = extractCode;
exports.exchangeCode = exchangeCode;
exports.refreshAccessToken = refreshAccessToken;
exports.detectTokenClientId = detectTokenClientId;
exports.createHttpClient = createHttpClient;
const crypto = __importStar(require("crypto"));
exports.crypto = crypto;
const axios_1 = __importDefault(require("axios"));
// ── Constants (from Python config_flow.py) ────────────────────────────────────
exports.KEYCLOAK_BASE = "https://smarthome.authz.bosch.com" +
    "/auth/realms/home_auth_provider/protocol/openid-connect";
exports.CLIENT_ID = "oss_residential_app";
/** Decoded from base64 — same value as Python config_flow.py CLIENT_SECRET */
exports.CLIENT_SECRET = Buffer.from("RjFqWnpzRzVOdHc3eDJWVmM4SjZxZ3NuaXNNT2ZhWmc=", "base64").toString("utf-8");
exports.SCOPES = "email offline_access profile openid";
/**
 * Redirect URI for the ioBroker manual flow (user pastes redirect URL).
 * Same as REDIRECT_URI_MANUAL in Python config_flow.py.
 */
exports.REDIRECT_URI = "https://www.bosch.com/boschcam";
exports.CLOUD_API = "https://residential.cbs.boschsecurity.com";
// ── Error classes ─────────────────────────────────────────────────────────────
/**
 * Bosch Keycloak rejected the refresh token (HTTP 400/401, invalid_grant).
 * Non-recoverable — user must re-authenticate interactively.
 */
class RefreshTokenInvalidError extends Error {
    constructor(message) {
        super(message);
        this.name = "RefreshTokenInvalidError";
    }
}
exports.RefreshTokenInvalidError = RefreshTokenInvalidError;
/**
 * Bosch Keycloak returned HTTP 5xx — server outage.
 * The token is likely still valid — retry after backoff, do NOT prompt re-login.
 */
class AuthServerOutageError extends Error {
    constructor(message) {
        super(message);
        this.name = "AuthServerOutageError";
    }
}
exports.AuthServerOutageError = AuthServerOutageError;
// ── PKCE helpers ──────────────────────────────────────────────────────────────
/**
 * Generate a PKCE code_verifier + code_challenge pair (S256 method).
 * Mirrors Python's _pkce_pair() in config_flow.py.
 */
function generatePkcePair() {
    const verifier = crypto.randomBytes(64).toString("base64url");
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    return { verifier, challenge };
}
/**
 * Build the Bosch Keycloak authorization URL for the manual ioBroker flow.
 * User opens this URL in a browser, logs in, and pastes the redirect URL back.
 *
 * @param challenge  PKCE code_challenge (S256)
 * @param state      Random state string (CSRF protection)
 * @returns Full authorization URL string
 */
function buildAuthUrl(challenge, state) {
    const params = new URLSearchParams({
        client_id: exports.CLIENT_ID,
        response_type: "code",
        scope: exports.SCOPES,
        redirect_uri: exports.REDIRECT_URI,
        code_challenge: challenge,
        code_challenge_method: "S256",
        state,
    });
    return `${exports.KEYCLOAK_BASE}/auth?${params.toString()}`;
}
/**
 * Extract the authorization code from the redirect URL the user pastes.
 * Mirrors Python _extract_code() in config_flow.py.
 *
 * @param redirectUrl  Full redirect URL (e.g. "https://www.bosch.com/boschcam?code=xxx&state=yyy")
 * @returns The authorization code, or null if not found / error present
 */
function extractCode(redirectUrl) {
    try {
        // Handle both full URLs and bare query strings (user may paste either)
        const urlStr = redirectUrl.trim();
        const hasScheme = urlStr.startsWith("http://") || urlStr.startsWith("https://");
        const parsed = new URL(hasScheme ? urlStr : `https://placeholder.invalid/?${urlStr.replace(/^[^?]*\?/, "")}`);
        if (parsed.searchParams.get("error")) {
            return null;
        }
        return parsed.searchParams.get("code");
    }
    catch {
        return null;
    }
}
// ── Token operations ──────────────────────────────────────────────────────────
/**
 * Exchange an authorization code for access + refresh tokens.
 *
 * Called after user completes the browser login and pastes the redirect URL.
 * Mirrors Python _exchange_code() in config_flow.py.
 *
 * @param httpClient  Axios instance (allows injection for testing)
 * @param code        Authorization code from redirect URL
 * @param verifier    PKCE code_verifier (generated at auth URL build time)
 * @returns TokenResult on success, null on transient error
 */
async function exchangeCode(httpClient, code, verifier) {
    try {
        const params = new URLSearchParams({
            client_id: exports.CLIENT_ID,
            client_secret: exports.CLIENT_SECRET,
            grant_type: "authorization_code",
            code,
            redirect_uri: exports.REDIRECT_URI,
            code_verifier: verifier,
        });
        const resp = await httpClient.post(`${exports.KEYCLOAK_BASE}/token`, params.toString(), { headers: { "Content-Type": "application/x-www-form-urlencoded" } });
        return {
            access_token: resp.data.access_token,
            refresh_token: resp.data.refresh_token,
            expires_in: resp.data.expires_in,
            refresh_expires_in: resp.data.refresh_expires_in ?? 0,
            token_type: resp.data.token_type,
            scope: resp.data.scope,
        };
    }
    catch (err) {
        if (axios_1.default.isAxiosError(err)) {
            const status = err.response?.status;
            if (status !== undefined) {
                const body = JSON.stringify(err.response?.data ?? "");
                if (status === 400 || status === 401) {
                    throw new RefreshTokenInvalidError(`Keycloak HTTP ${status}: ${body}`);
                }
                if (status >= 500) {
                    throw new AuthServerOutageError(`Bosch Keycloak HTTP ${status}`);
                }
            }
            // Network/timeout error — transient, caller may retry
            return null;
        }
        throw err;
    }
}
/**
 * Silently refresh an access token using a saved refresh_token.
 *
 * Mirrors Python _do_refresh() in config_flow.py.
 * Throws RefreshTokenInvalidError on 400/401 (user must re-login).
 * Throws AuthServerOutageError on 5xx (retry later).
 *
 * @param httpClient     Axios instance
 * @param refreshToken   Saved refresh_token from previous login
 * @returns New TokenResult on success, null on transient network error
 */
async function refreshAccessToken(httpClient, refreshToken) {
    try {
        const params = new URLSearchParams({
            client_id: exports.CLIENT_ID,
            client_secret: exports.CLIENT_SECRET,
            grant_type: "refresh_token",
            refresh_token: refreshToken,
        });
        const resp = await httpClient.post(`${exports.KEYCLOAK_BASE}/token`, params.toString(), { headers: { "Content-Type": "application/x-www-form-urlencoded" } });
        return {
            access_token: resp.data.access_token,
            refresh_token: resp.data.refresh_token,
            expires_in: resp.data.expires_in,
            refresh_expires_in: resp.data.refresh_expires_in ?? 0,
            token_type: resp.data.token_type,
            scope: resp.data.scope,
        };
    }
    catch (err) {
        if (axios_1.default.isAxiosError(err)) {
            const status = err.response?.status;
            if (status !== undefined) {
                const body = JSON.stringify(err.response?.data ?? "");
                // 400/401 → non-recoverable, token is invalid → user must re-login
                if (status === 400 || status === 401) {
                    throw new RefreshTokenInvalidError(`Keycloak HTTP ${status}: ${body}`);
                }
                // 5xx → Bosch server outage → token still valid, retry later
                if (status >= 500) {
                    throw new AuthServerOutageError(`Bosch Keycloak HTTP ${status}`);
                }
            }
            // Network/timeout error — transient, caller may retry
            return null;
        }
        throw err;
    }
}
/**
 * Parse a Bosch Keycloak JWT and return the `azp` (authorized party) claim.
 * Used to detect whether the stored token uses the legacy "residential_app"
 * client or the new OSS client "oss_residential_app".
 *
 * Mirrors Python _detect_token_client_id() in config_flow.py.
 *
 * @param bearerToken  Raw JWT access_token string
 * @returns Client ID string (e.g. "oss_residential_app") or null if unparseable
 */
function detectTokenClientId(bearerToken) {
    if (!bearerToken) {
        return null;
    }
    try {
        const parts = bearerToken.split(".");
        if (parts.length < 2) {
            return null;
        }
        // Pad base64url to a multiple of 4 for Buffer.from
        const padded = parts[1] + "=".repeat((4 - (parts[1].length % 4)) % 4);
        const payload = JSON.parse(Buffer.from(padded, "base64url").toString("utf-8"));
        const azp = payload["azp"];
        return azp != null ? String(azp) : null;
    }
    catch {
        return null;
    }
}
// ── HTTP client factory ───────────────────────────────────────────────────────
/**
 * Create a pre-configured Axios instance for Bosch API calls.
 * SSL verification is disabled (Bosch endpoints use self-signed certs on LAN;
 * for cloud endpoints this is safe since we pin the domain, not the cert).
 */
function createHttpClient() {
    return axios_1.default.create({
        timeout: 15_000,
        // Note: axios does not have a direct SSL skip option like aiohttp.
        // For cloud endpoints (Keycloak/CBS) this is fine with default SSL.
        // For local camera endpoints (Digest auth) use httpsAgent with rejectUnauthorized: false.
    });
}
//# sourceMappingURL=auth.js.map