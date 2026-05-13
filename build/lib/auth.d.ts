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
import { type AxiosInstance } from "axios";
export declare const KEYCLOAK_BASE: string;
export declare const CLIENT_ID = "oss_residential_app";
/** Decoded from base64 — same value as Python config_flow.py CLIENT_SECRET */
export declare const CLIENT_SECRET: string;
export declare const SCOPES = "email offline_access profile openid";
/**
 * Redirect URI for the ioBroker manual flow (user pastes redirect URL).
 * Same as REDIRECT_URI_MANUAL in Python config_flow.py.
 */
export declare const REDIRECT_URI = "https://www.bosch.com/boschcam";
export declare const CLOUD_API = "https://residential.cbs.boschsecurity.com";
/** Token response from Bosch Keycloak */
export interface TokenResult {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    refresh_expires_in: number;
    token_type: string;
    scope: string;
}
/** PKCE verifier + challenge pair */
export interface PkcePair {
    verifier: string;
    challenge: string;
}
/**
 * Bosch Keycloak rejected the refresh token (HTTP 400/401, invalid_grant).
 * Non-recoverable — user must re-authenticate interactively.
 */
export declare class RefreshTokenInvalidError extends Error {
    constructor(message: string);
}
/**
 * Bosch Keycloak returned HTTP 5xx — server outage.
 * The token is likely still valid — retry after backoff, do NOT prompt re-login.
 */
export declare class AuthServerOutageError extends Error {
    constructor(message: string);
}
/**
 * Generate a PKCE code_verifier + code_challenge pair (S256 method).
 * Mirrors Python's _pkce_pair() in config_flow.py.
 */
export declare function generatePkcePair(): PkcePair;
/**
 * Build the Bosch Keycloak authorization URL for the manual ioBroker flow.
 * User opens this URL in a browser, logs in, and pastes the redirect URL back.
 *
 * @param challenge  PKCE code_challenge (S256)
 * @param state      Random state string (CSRF protection)
 * @returns Full authorization URL string
 */
export declare function buildAuthUrl(challenge: string, state: string): string;
/**
 * Extract the authorization code from the redirect URL the user pastes.
 * Mirrors Python _extract_code() in config_flow.py.
 *
 * @param redirectUrl  Full redirect URL (e.g. "https://www.bosch.com/boschcam?code=xxx&state=yyy")
 * @returns The authorization code, or null if not found / error present
 */
export declare function extractCode(redirectUrl: string): string | null;
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
export declare function exchangeCode(httpClient: AxiosInstance, code: string, verifier: string): Promise<TokenResult | null>;
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
export declare function refreshAccessToken(httpClient: AxiosInstance, refreshToken: string): Promise<TokenResult | null>;
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
export declare function detectTokenClientId(bearerToken: string): string | null;
/**
 * Create a pre-configured Axios instance for Bosch API calls.
 *
 * TLS verification is disabled (`rejectUnauthorized: false`) for two reasons:
 *   1. Local LAN camera endpoints use self-signed certs that no public CA signs.
 *   2. The Bosch cloud CA chain is not always in Node.js's bundled CA store on
 *      macOS / containerised Linux — observed as "unable to get local issuer
 *      certificate" against `residential.cbs.boschsecurity.com`. The Python
 *      reference implementation (HA integration, CLI) passes `ssl=False` for the
 *      same reason. Domain pinning (we only ever call `*.boschsecurity.com` and
 *      `*.bosch.com`) keeps the security posture acceptable.
 */
export declare function createHttpClient(): AxiosInstance;
export { crypto };
//# sourceMappingURL=auth.d.ts.map