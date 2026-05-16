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

import * as crypto from "node:crypto";
import * as https from "node:https";
import axios, { type AxiosInstance } from "axios";

// ── Constants (from Python config_flow.py) ────────────────────────────────────

export const KEYCLOAK_BASE =
    "https://smarthome.authz.bosch.com" + "/auth/realms/home_auth_provider/protocol/openid-connect";

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
    /**
     *
     */
    access_token: string;
    /**
     *
     */
    refresh_token: string;
    /**
     *
     */
    expires_in: number; // seconds until access_token expires (~300)
    /**
     *
     */
    refresh_expires_in: number; // seconds until refresh_token expires
    /**
     *
     */
    token_type: string; // "Bearer"
    /**
     *
     */
    scope: string;
}

/** PKCE verifier + challenge pair */
export interface PkcePair {
    /**
     *
     */
    verifier: string;
    /**
     *
     */
    challenge: string;
}

// ── Error classes ─────────────────────────────────────────────────────────────

/**
 * Bosch Keycloak rejected the refresh token (HTTP 400/401, invalid_grant).
 * Non-recoverable — user must re-authenticate interactively.
 */
export class RefreshTokenInvalidError extends Error {
    /**
     *
     * @param message
     */
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
    /**
     *
     * @param message
     */
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
export function buildAuthUrl(challenge: string, state: string): string {
    const params = new URLSearchParams({
        client_id: CLIENT_ID,
        response_type: "code",
        scope: SCOPES,
        redirect_uri: REDIRECT_URI,
        code_challenge: challenge,
        code_challenge_method: "S256",
        state,
    });
    return `${KEYCLOAK_BASE}/auth?${params.toString()}`;
}

/**
 * Extract the authorization code from the redirect URL the user pastes.
 * Mirrors Python _extract_code() in config_flow.py.
 *
 * @param redirectUrl  Full redirect URL (e.g. "https://www.bosch.com/boschcam?code=xxx&state=yyy")
 * @returns The authorization code, or null if not found / error present
 */
export function extractCode(redirectUrl: string): string | null {
    try {
        // Handle both full URLs and bare query strings (user may paste either)
        const urlStr = redirectUrl.trim();
        const hasScheme = urlStr.startsWith("http://") || urlStr.startsWith("https://");
        const parsed = new URL(
            hasScheme ? urlStr : `https://placeholder.invalid/?${urlStr.replace(/^[^?]*\?/, "")}`,
        );
        if (parsed.searchParams.get("error")) {
            return null;
        }
        return parsed.searchParams.get("code");
    } catch {
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
export async function exchangeCode(
    httpClient: AxiosInstance,
    code: string,
    verifier: string,
): Promise<TokenResult | null> {
    try {
        const params = new URLSearchParams({
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            grant_type: "authorization_code",
            code,
            redirect_uri: REDIRECT_URI,
            code_verifier: verifier,
        });
        const resp = await httpClient.post<TokenResult>(
            `${KEYCLOAK_BASE}/token`,
            params.toString(),
            { headers: { "Content-Type": "application/x-www-form-urlencoded" } },
        );
        return {
            access_token: resp.data.access_token,
            refresh_token: resp.data.refresh_token,
            expires_in: resp.data.expires_in,
            refresh_expires_in: resp.data.refresh_expires_in ?? 0,
            token_type: resp.data.token_type,
            scope: resp.data.scope,
        };
    } catch (err: unknown) {
        if (axios.isAxiosError(err)) {
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
export async function refreshAccessToken(
    httpClient: AxiosInstance,
    refreshToken: string,
): Promise<TokenResult | null> {
    try {
        const params = new URLSearchParams({
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            grant_type: "refresh_token",
            refresh_token: refreshToken,
        });
        const resp = await httpClient.post<TokenResult>(
            `${KEYCLOAK_BASE}/token`,
            params.toString(),
            { headers: { "Content-Type": "application/x-www-form-urlencoded" } },
        );
        return {
            access_token: resp.data.access_token,
            refresh_token: resp.data.refresh_token,
            expires_in: resp.data.expires_in,
            refresh_expires_in: resp.data.refresh_expires_in ?? 0,
            token_type: resp.data.token_type,
            scope: resp.data.scope,
        };
    } catch (err: unknown) {
        if (axios.isAxiosError(err)) {
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
export function detectTokenClientId(bearerToken: string): string | null {
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
        const payload = JSON.parse(Buffer.from(padded, "base64url").toString("utf-8")) as Record<
            string,
            unknown
        >;
        const azp = payload.azp;
        if (typeof azp === "string") {
            return azp;
        }
        if (typeof azp === "number" || typeof azp === "boolean") {
            return String(azp);
        }
        return null;
    } catch {
        return null;
    }
}

// ── HTTP client factory ───────────────────────────────────────────────────────

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
export function createHttpClient(): AxiosInstance {
    return axios.create({
        timeout: 15_000,
        httpsAgent: new https.Agent({ rejectUnauthorized: false }),
    });
}

// Re-export crypto for tests (avoids direct crypto import in test files)
export { crypto };
