/**
 * HTTP Digest Authentication Helper (RFC 7616 / 2617)
 *
 * TypeScript port of the Python auth_utils.py async_digest_request().
 *
 * Algorithm support:
 *   MD5       (default, used by Bosch Gen1/Gen2 cameras)
 *   MD5-SESS  (session variant)
 *   SHA-256   (accepted if Bosch ever upgrades firmware)
 *   SHA-256-SESS
 *
 * Flow:
 *   1. Send initial request without Authorization header
 *   2. If server returns 401 with WWW-Authenticate: Digest, parse challenge
 *   3. Compute HA1, HA2, response per RFC 7616 §3.4
 *   4. Resend request with Authorization: Digest header
 *   5. Return the authenticated response
 *
 * qop support:
 *   qop=auth  → include cnonce + nc in response hash
 *   no qop    → legacy RFC 2617 mode (still used by older Bosch FW)
 */

import * as crypto from "node:crypto";
import * as https from "node:https";
import axios, { type AxiosResponse, type Method } from "axios";

// ── Types ─────────────────────────────────────────────────────────────────────

/** Parsed Digest challenge directives from WWW-Authenticate header */
export interface DigestChallenge {
    /**
     *
     */
    realm: string;
    /**
     *
     */
    nonce: string;
    /**
     *
     */
    opaque?: string;
    /**
     *
     */
    qop?: string; // "auth" | "auth-int" | undefined (no qop = legacy)
    /**
     *
     */
    algorithm?: string; // "MD5" | "MD5-SESS" | "SHA-256" | "SHA-256-SESS"
}

/** Options for digestRequest() */
export interface DigestRequestOptions {
    /**
     *
     */
    method?: Method;
    /**
     *
     */
    data?: string | Buffer;
    /**
     *
     */
    headers?: Record<string, string>;
    /** Timeout in milliseconds (default: 10_000) */
    timeout?: number;
    /**
     * Whether to reject invalid SSL certificates (default: false).
     * Bosch cameras use self-signed TLS certs on the local network.
     */
    rejectUnauthorized?: boolean;
}

/** Result of a digest-authenticated request */
export interface DigestResponse {
    /**
     *
     */
    status: number;
    /**
     *
     */
    headers: Record<string, string>;
    /**
     *
     */
    data: Buffer;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Compute MD5 hex digest of a UTF-8 string.
 * Mirrors Python _md5() in auth_utils.py.
 *
 * @param input
 */
function md5(input: string): string {
    return crypto.createHash("md5").update(input, "utf-8").digest("hex");
}

/**
 * Compute SHA-256 hex digest of a UTF-8 string.
 * Mirrors Python _sha256() in auth_utils.py.
 *
 * @param input
 */
function sha256(input: string): string {
    return crypto.createHash("sha256").update(input, "utf-8").digest("hex");
}

/**
 * Select the hash function based on the Digest algorithm directive.
 * Defaults to MD5 if algorithm is absent or unrecognized.
 *
 * @param algorithm
 */
function selectHashFn(algorithm: string | undefined): (s: string) => string {
    const alg = (algorithm ?? "MD5").toUpperCase();
    if (alg.startsWith("SHA-256")) {
        return sha256;
    }
    return md5;
}

/**
 * Parse the WWW-Authenticate: Digest header into a DigestChallenge object.
 * Mirrors Python _parse_digest_challenge() in auth_utils.py.
 *
 * @param wwwAuthenticate
 * @throws Error if the header is not a Digest challenge or missing `nonce`
 */
export function parseDigestChallenge(wwwAuthenticate: string): DigestChallenge {
    const [scheme, ...rest] = wwwAuthenticate.trim().split(/\s+/);
    if (scheme.toLowerCase() !== "digest") {
        throw new Error(`Expected Digest scheme, got: ${scheme}`);
    }

    const paramsStr = rest.join(" ");
    const params: Record<string, string> = {};
    // Match key=value or key="value" pairs (same regex as Python port)
    const re = /(\w+)=(?:"([^"]*)"|([^,\s]+))/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(paramsStr)) !== null) {
        const key = match[1].toLowerCase();
        const value = match[2] !== undefined ? match[2] : match[3];
        params[key] = value;
    }

    if (!params.nonce) {
        throw new Error("Digest challenge missing required 'nonce' directive");
    }

    return {
        realm: params.realm ?? "",
        nonce: params.nonce,
        opaque: params.opaque,
        qop: params.qop,
        algorithm: params.algorithm,
    };
}

/**
 * Compute the Authorization: Digest header value for a given challenge.
 * Mirrors Python _build_digest_header() in auth_utils.py.
 *
 * @param method     HTTP method (GET, PUT, POST, …)
 * @param url        Full request URL (path + optional query string used for uri field)
 * @param username   Digest username
 * @param password   Digest password
 * @param challenge  Parsed DigestChallenge from WWW-Authenticate header
 * @returns          Full "Digest ..." header value
 */
export function buildDigestHeader(
    method: string,
    url: string,
    username: string,
    password: string,
    challenge: DigestChallenge,
): string {
    const { realm, nonce, opaque, qop, algorithm } = challenge;
    const hash = selectHashFn(algorithm);
    const alg = (algorithm ?? "MD5").toUpperCase();

    // Extract URI path (+ query) from full URL — RFC 7616 §3.4 digest-uri
    let uri: string;
    try {
        const parsed = new URL(url);
        uri = parsed.pathname + (parsed.search ?? "");
    } catch {
        // Fallback for relative URLs or malformed input
        uri = url.split("?")[0] ?? url;
    }

    // HA1
    let ha1 = hash(`${username}:${realm}:${password}`);
    const cnonce = crypto.randomBytes(8).toString("hex");
    if (alg === "MD5-SESS" || alg === "SHA-256-SESS") {
        ha1 = hash(`${ha1}:${nonce}:${cnonce}`);
    }

    // HA2
    const ha2 = hash(`${method.toUpperCase()}:${uri}`);

    // Response
    const nc = "00000001";
    const qopValue = qop?.split(",")[0].trim().toLowerCase() ?? "";
    let response: string;
    if (qopValue === "auth") {
        response = hash(`${ha1}:${nonce}:${nc}:${cnonce}:${qopValue}:${ha2}`);
    } else {
        // Legacy: no qop
        response = hash(`${ha1}:${nonce}:${ha2}`);
    }

    // Build header parts
    const parts: string[] = [
        `username="${username}"`,
        `realm="${realm}"`,
        `nonce="${nonce}"`,
        `uri="${uri}"`,
        `algorithm=${alg}`,
        `response="${response}"`,
        `cnonce="${cnonce}"`,
    ];
    if (qopValue === "auth") {
        parts.push(`qop=${qopValue}`, `nc=${nc}`);
    }
    if (opaque) {
        parts.push(`opaque="${opaque}"`);
    }

    return `Digest ${parts.join(", ")}`;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Perform an HTTP request with RFC 7616 Digest authentication.
 *
 * TypeScript port of Python's async_digest_request() in auth_utils.py.
 *
 * Sends an initial unauthenticated request. If the server responds 401
 * with WWW-Authenticate: Digest, parses the challenge, computes the
 * Digest response, and retries with Authorization header.
 *
 * If the server returns 200 on the first attempt (no auth required),
 * that response is returned directly.
 *
 * Usage:
 * ```ts
 * const resp = await digestRequest(
 *   "https://192.0.2.1/rcp/",
 *   "service",
 *   "secret",
 *   { method: "GET" }
 * );
 * console.log(resp.status, resp.data.toString());
 * ```
 *
 * @param url       Full URL (including https://)
 * @param username  Digest username
 * @param password  Digest password
 * @param options   Optional method, data, headers, timeout, rejectUnauthorized
 * @returns         DigestResponse (status + headers + data Buffer)
 * @throws Error    If 401 response has no WWW-Authenticate or missing nonce
 * @throws Error    On network-level errors (propagated from axios)
 */
export async function digestRequest(
    url: string,
    username: string,
    password: string,
    options: DigestRequestOptions = {},
): Promise<DigestResponse> {
    const method: Method = options.method ?? "GET";
    const timeout = options.timeout ?? 10_000;
    const rejectUnauthorized = options.rejectUnauthorized ?? false;

    const httpsAgent = new https.Agent({ rejectUnauthorized });

    const axiosOpts = {
        method,
        url,
        httpsAgent,
        timeout,
        responseType: "arraybuffer" as const,
        validateStatus: () => true, // handle all status codes manually
        headers: { ...(options.headers ?? {}) },
        ...(options.data !== undefined ? { data: options.data } : {}),
    };

    // Step 1: Initial request without Authorization
    const firstResp: AxiosResponse<Buffer> = await axios(axiosOpts);

    if (firstResp.status !== 401) {
        return {
            status: firstResp.status,
            headers: firstResp.headers as Record<string, string>,
            data: Buffer.from(firstResp.data),
        };
    }

    // Step 2: Parse 401 challenge
    const wwwAuth: string = (firstResp.headers["www-authenticate"] as string) ?? "";
    if (!wwwAuth) {
        throw new Error(`Server returned 401 without WWW-Authenticate header for ${url}`);
    }

    const challenge = parseDigestChallenge(wwwAuth);
    const authHeader = buildDigestHeader(method, url, username, password, challenge);

    // Step 3: Retry with Authorization header
    const authOpts = {
        ...axiosOpts,
        headers: {
            ...axiosOpts.headers,
            Authorization: authHeader,
        },
    };

    const secondResp: AxiosResponse<Buffer> = await axios(authOpts);
    return {
        status: secondResp.status,
        headers: secondResp.headers as Record<string, string>,
        data: Buffer.from(secondResp.data),
    };
}

/**
 * Convenience wrapper: perform a GET request with Digest auth.
 *
 * @param url
 * @param username
 * @param password
 * @param options
 */
export async function digestGet(
    url: string,
    username: string,
    password: string,
    options?: Omit<DigestRequestOptions, "method">,
): Promise<DigestResponse> {
    return digestRequest(url, username, password, { ...options, method: "GET" });
}

/**
 * Convenience wrapper: perform a PUT request with Digest auth.
 *
 * @param url
 * @param username
 * @param password
 * @param data
 * @param options
 */
export async function digestPut(
    url: string,
    username: string,
    password: string,
    data: string | Buffer,
    options?: Omit<DigestRequestOptions, "method" | "data">,
): Promise<DigestResponse> {
    return digestRequest(url, username, password, {
        ...options,
        method: "PUT",
        data,
    });
}
