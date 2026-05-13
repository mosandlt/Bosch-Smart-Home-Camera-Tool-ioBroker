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

import axios, { type AxiosInstance } from "axios";
import { CookieJar } from "tough-cookie";
import { wrapper } from "axios-cookiejar-support";

import { generatePkcePair, buildAuthUrl, exchangeCode, type TokenResult } from "./auth";

import * as crypto from "node:crypto";

// ── Error classes ─────────────────────────────────────────────────────────────

/** Thrown when SingleKey ID rejects username or password. */
export class InvalidCredentialsError extends Error {
    /**
     *
     */
    constructor(message = "Invalid credentials") {
        super(message);
        this.name = "InvalidCredentialsError";
    }
}

/**
 * Thrown when the login flow requires interactive verification:
 * - hCaptcha on the email page (headless blocker as of 2026-05-13)
 * - MFA / 2FA challenge
 * - Additional account verification
 */
export class MfaRequiredError extends Error {
    /**
     *
     */
    constructor(message = "MFA or additional verification required") {
        super(message);
        this.name = "MfaRequiredError";
    }
}

/** Thrown when the login flow fails for non-credential reasons (5xx, network, parsing errors). */
export class LoginFlowError extends Error {
    /**
     *
     */
    constructor(message: string) {
        super(message);
        this.name = "LoginFlowError";
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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
export function parseFormFields(
    html: string,
    pageUrl: string,
): { action: string | null; csrf: string | null } {
    // Find the first form that either has no action OR has a login-path action.
    // The language-switcher form always has action="/en-gb/language" → skip it.
    const formMatches = [...html.matchAll(/<form[^>]*>/gi)];
    let action: string | null = null;

    for (const m of formMatches) {
        const formTag = m[0];
        const actionMatch = formTag.match(/action="([^"]+)"/i);
        if (!actionMatch) {
            // No action attr → form POSTs to current URL
            action = pageUrl;
            break;
        }
        const rawAction = actionMatch[1].replace(/&amp;/g, "&");
        // Skip the language switcher and similar utility forms
        if (/\/language$|\/language\?/i.test(rawAction)) {
            continue;
        }
        // Any other action URL: resolve relative against base
        try {
            action = new URL(rawAction, pageUrl).toString();
        } catch {
            action = null;
        }
        break;
    }

    // Extract the first CSRF token (they are typically duplicated 3× on the page)
    const csrfMatch = html.match(/name="__RequestVerificationToken"[^>]+value="([^"]+)"/i);
    const csrf = csrfMatch?.[1] ?? null;

    return { action, csrf };
}

/**
 * Extract the authorization code from a full redirect URL (query string).
 *
 * @param location  Full URL (after following redirects to the OIDC callback)
 * @returns The code query parameter, or null if not present
 */
export function extractCodeFromLocation(location: string): string | null {
    try {
        const url = location.startsWith("http")
            ? new URL(location)
            : new URL(
                  `https://placeholder.invalid${location.startsWith("/") ? "" : "/"}${location}`,
              );
        if (url.searchParams.get("error")) {
            return null;
        }
        return url.searchParams.get("code");
    } catch {
        return null;
    }
}

/**
 * Detect hCaptcha / reCAPTCHA on a page.
 * SingleKey ID uses hCaptcha (sitekey f8fe2d56-...) on the email submit button.
 *
 * @param html
 */
export function detectCaptcha(html: string): boolean {
    return /h-captcha|recaptcha|g-recaptcha|data-sitekey/i.test(html);
}

/**
 * Detect MFA / 2FA challenge page.
 *
 * @param html
 */
export function detectMfa(html: string): boolean {
    return /enter (verification|authentication) code|two-factor|authenticator app|verify your identity/i.test(
        html,
    );
}

// Keep the old extractFormAction export for backward-compatibility with existing tests
// (tests that stub a Keycloak-style form with explicit action= still pass).
/**
 *
 */
export function extractFormAction(html: string): string | null {
    const match = html.match(/<form[^>]+action="([^"]+)"/i);
    if (!match) {
        return null;
    }
    return match[1]
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
}

// ── Main export ───────────────────────────────────────────────────────────────

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
export async function loginWithCredentials(
    httpClient: AxiosInstance,
    username: string,
    password: string,
): Promise<TokenResult> {
    // Step 1: PKCE + auth URL
    const { verifier, challenge } = generatePkcePair();
    const state = crypto.randomBytes(16).toString("base64url");
    const authUrl = buildAuthUrl(challenge, state);

    // Cookie jar: persists .AspNetCore.Antiforgery + SKI_session cookies
    // across all redirect hops on singlekey-id.com.
    const jar = new CookieJar();
    const jarClient = wrapper(
        axios.create({
            timeout: httpClient.defaults.timeout ?? 15_000,
            headers: {
                "User-Agent": "iobroker.bosch-smart-home-camera/0.2.0",
            },
            httpsAgent: httpClient.defaults.httpsAgent,
            jar,
            withCredentials: true,
            maxRedirects: 15, // Bosch auth chain has 7+ hops
        }),
    );

    // ── Step 2: GET email page ───────────────────────────────────────────────
    let emailPageUrl: string;
    let emailHtml: string;

    try {
        const emailPageResp = await jarClient.get<string>(authUrl, {
            headers: { Accept: "text/html" },
            responseType: "text",
        });
        if (emailPageResp.status >= 500) {
            throw new LoginFlowError(`Auth server error HTTP ${emailPageResp.status}`);
        }
        // After following redirects, request.res.responseUrl is the final URL
        emailPageUrl =
            (emailPageResp.request as { res?: { responseUrl?: string } })?.res?.responseUrl ??
            authUrl;
        emailHtml = emailPageResp.data;
    } catch (err: unknown) {
        if (err instanceof LoginFlowError) {
            throw err;
        }
        if (axios.isAxiosError(err)) {
            const status = err.response?.status;
            if (status === 400) {
                throw new LoginFlowError(
                    `Auth page returned HTTP 400: ${JSON.stringify(err.response?.data ?? "").slice(0, 200)}`,
                );
            }
            if (status !== undefined && status >= 500) {
                throw new LoginFlowError(`Auth server HTTP ${status}`);
            }
            throw new LoginFlowError(`Network error fetching auth page: ${(err as Error).message}`);
        }
        throw new LoginFlowError(`Unexpected error fetching auth page: ${String(err)}`);
    }

    // ── Step 3: Parse email form ─────────────────────────────────────────────
    const emailForm = parseFormFields(emailHtml, emailPageUrl);
    if (!emailForm.action || !emailForm.csrf) {
        throw new LoginFlowError(
            "Email page: could not find form action or CSRF token — page structure changed",
        );
    }

    // ── Step 4: POST email ───────────────────────────────────────────────────
    // Extract returnPath value (needed by SingleKey ID to re-render the correct form state)
    const returnPathMatch = emailHtml.match(/name="returnPath"[^>]+value="([^"]*)"/i);
    const returnPath = returnPathMatch?.[1]?.replace(/&amp;/g, "&") ?? "";

    const emailBody = new URLSearchParams({
        "UserIdentifierInput.EmailInput.StringValue": username,
        __RequestVerificationToken: emailForm.csrf,
        credential: "",
        returnPath: returnPath,
    });

    let passwordPageUrl: string;
    let passwordHtml: string;

    try {
        const passwordPageResp = await jarClient.post<string>(
            emailForm.action,
            emailBody.toString(),
            {
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                },
                responseType: "text",
            },
        );

        if (passwordPageResp.status >= 500) {
            throw new LoginFlowError(`Email POST HTTP ${passwordPageResp.status}`);
        }
        if (passwordPageResp.status >= 400) {
            throw new LoginFlowError(`Email POST rejected HTTP ${passwordPageResp.status}`);
        }

        passwordPageUrl =
            (passwordPageResp.request as { res?: { responseUrl?: string } })?.res?.responseUrl ??
            emailForm.action;
        passwordHtml = passwordPageResp.data;
    } catch (err: unknown) {
        if (err instanceof LoginFlowError) {
            throw err;
        }
        if (axios.isAxiosError(err)) {
            const status = err.response?.status;
            if (status !== undefined && status >= 500) {
                throw new LoginFlowError(`Email POST HTTP ${status}`);
            }
            throw new LoginFlowError(`Network error during email POST: ${(err as Error).message}`);
        }
        throw new LoginFlowError(`Unexpected error during email POST: ${String(err)}`);
    }

    // ── Step 5: Detect hCaptcha / email rejected / MFA ───────────────────────
    // If we're still on the email page (no PasswordInput field) → hCaptcha or invalid email.
    // SingleKey ID returns 200 with the same email form when:
    //   (a) h-captcha-response is missing/invalid (most common headless case)
    //   (b) The email address is not registered
    // We can distinguish by checking whether the email was pre-filled in the response.
    const isStillOnEmailPage =
        !passwordHtml.includes("PasswordInput") &&
        (passwordPageUrl.includes("/login") || passwordPageUrl.includes("/en-gb/login"));

    if (isStillOnEmailPage) {
        // Check whether the email was bounced (pre-filled email indicates accepted, captcha needed)
        const emailPreFilled = passwordHtml.includes(username);
        if (emailPreFilled && detectCaptcha(passwordHtml)) {
            throw new MfaRequiredError(
                "hCaptcha required on email page — headless programmatic login is blocked by " +
                    "singlekey-id.com. Use the browser-based login URL in the ioBroker Admin UI.",
            );
        }
        // Email not pre-filled → email was rejected (not registered or invalid)
        throw new InvalidCredentialsError(
            "Email rejected by Bosch SingleKey ID — check your email address",
        );
    }

    if (detectMfa(passwordHtml)) {
        throw new MfaRequiredError("MFA/2FA required for this account");
    }

    if (detectCaptcha(passwordHtml) && !passwordHtml.includes("PasswordInput")) {
        throw new MfaRequiredError("CAPTCHA challenge on password page");
    }

    // ── Step 6: Parse password form ──────────────────────────────────────────
    const passwordForm = parseFormFields(passwordHtml, passwordPageUrl);
    if (!passwordForm.action || !passwordForm.csrf) {
        throw new LoginFlowError(
            "Password page: could not find form action or CSRF token — page structure changed",
        );
    }

    // Extract returnPath for password page
    const pwdReturnPathMatch = passwordHtml.match(/name="returnPath"[^>]+value="([^"]*)"/i);
    const pwdReturnPath = pwdReturnPathMatch?.[1]?.replace(/&amp;/g, "&") ?? "";

    // ── Step 7: POST password ────────────────────────────────────────────────
    // Password field name: `Password.PasswordInput.StringValue`
    // (matches SingleKey ID naming convention: UserIdentifierInput.EmailInput.StringValue)
    const passwordBody = new URLSearchParams({
        "Password.PasswordInput.StringValue": password,
        __RequestVerificationToken: passwordForm.csrf,
        credential: "",
        returnPath: pwdReturnPath,
    });

    let finalUrl: string;

    try {
        const submitResp = await jarClient.post<string>(
            passwordForm.action,
            passwordBody.toString(),
            {
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                },
                responseType: "text",
                // Follow redirects: Bosch OIDC callback chain after successful password
                maxRedirects: 15,
            },
        );

        finalUrl =
            (submitResp.request as { res?: { responseUrl?: string } })?.res?.responseUrl ??
            passwordForm.action;

        const submitHtml = submitResp.data ?? "";

        // 200 with password form → wrong password
        if (submitResp.status === 200 && submitHtml.includes("PasswordInput")) {
            throw new InvalidCredentialsError("Password rejected by Bosch SingleKey ID");
        }

        if (submitResp.status >= 500) {
            throw new LoginFlowError(`Password POST HTTP ${submitResp.status}`);
        }
    } catch (err: unknown) {
        if (err instanceof InvalidCredentialsError || err instanceof LoginFlowError) {
            throw err;
        }
        if (axios.isAxiosError(err)) {
            const status = err.response?.status;
            if (status !== undefined && status >= 500) {
                throw new LoginFlowError(`Password POST HTTP ${status}`);
            }
            throw new LoginFlowError(
                `Network error during password POST: ${(err as Error).message}`,
            );
        }
        throw new LoginFlowError(`Unexpected error during password POST: ${String(err)}`);
    }

    // ── Step 8: Extract OIDC code from final URL ─────────────────────────────
    const code = extractCodeFromLocation(finalUrl);
    if (!code) {
        // Could be MFA redirect or other interactive step
        if (/mfa|two-factor|2fa|otp/i.test(finalUrl)) {
            throw new MfaRequiredError(
                `MFA redirect after password: ${finalUrl.substring(0, 120)}`,
            );
        }
        throw new LoginFlowError(`No auth code in final URL: ${finalUrl.substring(0, 200)}`);
    }

    // ── Step 9: Exchange code for tokens ─────────────────────────────────────
    const tokens = await exchangeCode(httpClient, code, verifier);
    if (!tokens) {
        throw new LoginFlowError("Token exchange returned null (transient network error)");
    }
    return tokens;
}
