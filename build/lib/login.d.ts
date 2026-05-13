/**
 * @deprecated  Programmatic login is BLOCKED in production by hCaptcha on singlekey-id.com.
 *              main.ts no longer calls loginWithCredentials().
 *              This file is kept for tests / future captcha-solver paths only.
 *              The active login path is: Browser PKCE + paste redirect URL (main.ts handleRedirectPaste).
 *
 * Programmatic OAuth2 Login for Bosch SingleKey ID
 *
 * Implements the end-to-end 2-step username/password login flow without
 * browser interaction.
 *
 * Flow:
 *   1. generatePkcePair() + buildAuthUrl()
 *   2. GET auth URL → Bosch Keycloak → 303 broker/skid-p → 303 singlekey-id.com
 *      → 302 chain → singlekey-id.com/en-gb/login?ReturnUrl=... (email page)
 *      Cookie jar persists session cookies across all redirect hops.
 *   3. Extract CSRF + returnPath from email page (form has NO action attr → post to page URL)
 *   4. POST email to same URL → singlekey-id.com returns password page (200)
 *      ⚠ hCaptcha guard: the "Continue" button is disabled by JS until captcha is solved.
 *        Without a valid h-captcha-response the server returns the email page again.
 *        Detected via: page title is still "Welcome" / no PasswordInput field found.
 *   5. Extract password form action + new CSRF from password page
 *   6. POST password → Bosch Keycloak callback → 302 to REDIRECT_URI?code=...
 *   7. Extract code from final URL
 *   8. exchangeCode() → TokenResult
 *
 * hCaptcha blocker (discovered 2026-05-13):
 *   singlekey-id.com enforces hCaptcha (sitekey f8fe2d56-ad42-4f44-b9fe-5b30fcb0dd38)
 *   on the email→password step. The submit button is disabled by default; JS enables it
 *   only after the hCaptcha widget fires its callback. POSTing without a real
 *   h-captcha-response token causes the server to silently return the same email page.
 *   → MfaRequiredError is thrown until a captcha-solving path is added.
 *
 * Cookie handling:
 *   singlekey-id.com sets .AspNetCore.Antiforgery.* + SKI_session cookies.
 *   Without a persistent cookie jar all POSTs fail with CSRF validation errors (400).
 *   We use tough-cookie + axios-cookiejar-support for automatic cross-redirect
 *   cookie persistence.
 *
 * Password field name:
 *   Traced as `Password.PasswordInput.StringValue` (consistent with the email field naming
 *   convention `UserIdentifierInput.EmailInput.StringValue`). Could not be confirmed
 *   server-side because hCaptcha prevents reaching the password page headlessly.
 *
 * References:
 *   Python CLI get_token.py: _pkce_pair, _build_auth_url, _exchange_code
 *   HA config_flow.py: _build_auth_url, _extract_code, _exchange_code
 */
import { type AxiosInstance } from "axios";
import { type TokenResult } from "./auth";
/** Thrown when SingleKey ID rejects username or password. */
export declare class InvalidCredentialsError extends Error {
    /**
     *
     */
    constructor(message?: string);
}
/**
 * Thrown when the login flow requires interactive verification:
 * - hCaptcha on the email page (headless blocker as of 2026-05-13)
 * - MFA / 2FA challenge
 * - Additional account verification
 */
export declare class MfaRequiredError extends Error {
    /**
     *
     */
    constructor(message?: string);
}
/** Thrown when the login flow fails for non-credential reasons (5xx, network, parsing errors). */
export declare class LoginFlowError extends Error {
    /**
     *
     */
    constructor(message: string);
}
/**
 * Parse a form's POST target URL and its CSRF token.
 *
 * SingleKey ID uses ASP.NET Core Razor Pages:
 * - The main email/password forms have NO action attribute → POST goes to same URL.
 * - A language-switcher form at the bottom has action="/en-gb/language".
 * - We want the first form without an action (or with a relative action that matches
 *   the login path), NOT the language form.
 *
 * @param html     Raw HTML of the page
 * @param pageUrl  Current page URL (used when form has no action attribute)
 * @returns Resolved action URL and CSRF token (or nulls if not found)
 */
export declare function parseFormFields(html: string, pageUrl: string): {
    action: string | null;
    csrf: string | null;
};
/**
 * Extract the authorization code from a full redirect URL (query string).
 *
 * @param location  Full URL (after following redirects to the OIDC callback)
 * @returns The code query parameter, or null if not present
 */
export declare function extractCodeFromLocation(location: string): string | null;
/**
 * Detect hCaptcha / reCAPTCHA on a page.
 * SingleKey ID uses hCaptcha (sitekey f8fe2d56-...) on the email submit button.
 *
 * @param html
 */
export declare function detectCaptcha(html: string): boolean;
/**
 * Detect MFA / 2FA challenge page.
 *
 * @param html
 */
export declare function detectMfa(html: string): boolean;
/**
 *
 */
export declare function extractFormAction(html: string): string | null;
/**
 * End-to-end programmatic OAuth2 login for Bosch SingleKey ID.
 *
 * 2-step flow: POST email → POST password → capture OIDC code → exchange tokens.
 *
 * ⚠ hCaptcha blocker: As of 2026-05-13, singlekey-id.com enforces hCaptcha on the
 * email submission step. This function correctly detects the captcha and throws
 * MfaRequiredError("hCaptcha required..."). No programmatic bypass is implemented.
 * The ioBroker Admin UI should guide the user to authenticate via browser link.
 *
 * @param httpClient  Axios instance (timeout + TLS settings inherited)
 * @param username    Bosch SingleKey ID email address
 * @param password    Bosch SingleKey ID password
 * @returns TokenResult on success
 * @throws InvalidCredentialsError  — email or password rejected
 * @throws MfaRequiredError         — hCaptcha / MFA / interactive step required
 * @throws LoginFlowError           — network errors, server errors, parsing failures
 */
export declare function loginWithCredentials(httpClient: AxiosInstance, username: string, password: string): Promise<TokenResult>;
//# sourceMappingURL=login.d.ts.map