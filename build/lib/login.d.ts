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
import { type AxiosInstance } from "axios";
import { type TokenResult } from "./auth";
/** Thrown when Keycloak rejects username/password (200 response with error HTML, no redirect). */
export declare class InvalidCredentialsError extends Error {
    constructor(message?: string);
}
/** Thrown when Keycloak demands an MFA / interactive step (302 to a page without a code). */
export declare class MfaRequiredError extends Error {
    constructor(message?: string);
}
/** Thrown when the login flow fails for non-credential reasons (5xx, network, parsing errors). */
export declare class LoginFlowError extends Error {
    constructor(message: string);
}
/**
 * Extract the Keycloak login form action URL from the auth page HTML.
 *
 * Keycloak renders a <form ... action="https://..."> on its login page.
 * The action URL is the direct POST endpoint for username/password.
 *
 * @param html  Raw HTML of the Keycloak login page
 * @returns The action URL, or null if not found
 */
export declare function extractFormAction(html: string): string | null;
/**
 * Extract the authorization code from a redirect Location header.
 *
 * @param location  The Location header value from a 302 response
 * @returns The code query parameter, or null if not present
 */
export declare function extractCodeFromLocation(location: string): string | null;
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
export declare function loginWithCredentials(httpClient: AxiosInstance, username: string, password: string): Promise<TokenResult>;
//# sourceMappingURL=login.d.ts.map