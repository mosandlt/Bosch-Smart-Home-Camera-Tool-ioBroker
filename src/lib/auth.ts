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

import * as crypto from "crypto";
import axios, { type AxiosInstance } from "axios";

// ── Constants (from Python config_flow.py) ────────────────────────────────────

export const KEYCLOAK_BASE =
    "https://smarthome.authz.bosch.com" +
    "/auth/realms/home_auth_provider/protocol/openid-connect";

export const CLIENT_ID = "oss_residential_app";

/** Decoded from base64 — same value as Python config_flow.py CLIENT_SECRET */
export const CLIENT_SECRET = Buffer.from(
    "RjFqWnpzRzVOdHc3eDJWVmM4SjZxZ3NuaXNNT2ZhWmc=",
    "base64",
).toString("utf-8");

export const SCOPES = "email offline_access profile openid";

/**
 * Redirect URI for the ioBroker manual flow (user pastes redirect URL).
 * Same as REDIRECT_URI_MANUAL in Python config_flow.py.
 */
export const REDIRECT_URI = "https://www.bosch.com/boschcam";

export const CLOUD_API = "https://residential.cbs.boschsecurity.com";

// ── Types ─────────────────────────────────────────────────────────────────────

/** Token response from Bosch Keycloak */
export interface TokenResult {
    access_token: string;
    refresh_token: string;
    expires_in: number;         // seconds until access_token expires (~300)
    refresh_expires_in: number; // seconds until refresh_token expires
    token_type: string;         // "Bearer"
    scope: string;
}

/** PKCE verifier + challenge pair */
export interface PkcePair {
    verifier: string;
    challenge: string;
}

// ── Error classes ─────────────────────────────────────────────────────────────

/**
 * Bosch Keycloak rejected the refresh token (HTTP 400/401, invalid_grant).
 * Non-recoverable — user must re-authenticate interactively.
 */
export class RefreshTokenInvalidError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "RefreshTokenInvalidError";
    }
}

/**
 * Bosch Keycloak returned HTTP 5xx — server outage.
 * The token is likely still valid — retry after backoff, do NOT prompt re-login.
 */
export class AuthServerOutageError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "AuthServerOutageError";
    }
}

// ── PKCE helpers ──────────────────────────────────────────────────────────────

/**
 * Generate a PKCE code_verifier + code_challenge pair (S256 method).
 * Mirrors Python's _pkce_pair() in config_flow.py.
 */
export function generatePkcePair(): PkcePair {
    // TODO: implement
    // verifier  = crypto.randomBytes(64).toString('base64url')
    // challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
    throw new Error("TODO: port from Python config_flow.py _pkce_pair()");
}

/**
 * Build the Bosch Keycloak authorization URL for the manual ioBroker flow.
 * User opens this URL in a browser, logs in, and pastes the redirect URL back.
 *
 * @param challenge  PKCE code_challenge (S256)
 * @param state      Random state string (CSRF protection)
 * @returns Full authorization URL string
 */
export function buildAuthUrl(challenge: string, state: string): string {
    // TODO: implement
    // Build query string with client_id, response_type=code, scope, redirect_uri,
    // code_challenge, code_challenge_method=S256, state
    throw new Error("TODO: port from Python config_flow.py _build_auth_url()");
}

/**
 * Extract the authorization code from the redirect URL the user pastes.
 * Mirrors Python _extract_code() in config_flow.py.
 *
 * @param redirectUrl  Full redirect URL (e.g. "https://www.bosch.com/boschcam?code=xxx&state=yyy")
 * @returns The authorization code, or null if not found / error present
 */
export function extractCode(redirectUrl: string): string | null {
    // TODO: implement
    // Parse query string, check for "error" param, return "code" param
    throw new Error("TODO: port from Python config_flow.py _extract_code()");
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
export async function exchangeCode(
    httpClient: AxiosInstance,
    code: string,
    verifier: string,
): Promise<TokenResult | null> {
    // TODO: implement
    // POST {KEYCLOAK_BASE}/token
    // body: client_id, client_secret, grant_type=authorization_code,
    //       code, redirect_uri=REDIRECT_URI, code_verifier=verifier
    // Return parsed token JSON or null on error
    throw new Error("TODO: port from Python config_flow.py _exchange_code()");
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
export async function refreshAccessToken(
    httpClient: AxiosInstance,
    refreshToken: string,
): Promise<TokenResult | null> {
    // TODO: implement
    // POST {KEYCLOAK_BASE}/token
    // body: client_id, client_secret, grant_type=refresh_token, refresh_token
    // Handle 400/401 → RefreshTokenInvalidError
    // Handle 5xx    → AuthServerOutageError
    // Handle network error → return null (caller retries)
    throw new Error("TODO: port from Python config_flow.py _do_refresh()");
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
export function detectTokenClientId(bearerToken: string): string | null {
    // TODO: implement
    // Split by ".", base64url-decode part[1], JSON.parse, return payload.azp
    throw new Error(
        "TODO: port from Python config_flow.py _detect_token_client_id()",
    );
}

// ── HTTP client factory ───────────────────────────────────────────────────────

/**
 * Create a pre-configured Axios instance for Bosch API calls.
 * SSL verification is disabled (Bosch endpoints use self-signed certs on LAN;
 * for cloud endpoints this is safe since we pin the domain, not the cert).
 */
export function createHttpClient(): AxiosInstance {
    return axios.create({
        timeout: 15_000,
        // Note: axios does not have a direct SSL skip option like aiohttp.
        // For cloud endpoints (Keycloak/CBS) this is fine with default SSL.
        // For local camera endpoints (Digest auth) use httpsAgent with rejectUnauthorized: false.
    });
}

// Re-export crypto for tests (avoids direct crypto import in test files)
export { crypto };
