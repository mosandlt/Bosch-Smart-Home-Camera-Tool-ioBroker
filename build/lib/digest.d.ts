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
import { type Method } from "axios";
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
    qop?: string;
    /**
     *
     */
    algorithm?: string;
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
/**
 * Parse the WWW-Authenticate: Digest header into a DigestChallenge object.
 * Mirrors Python _parse_digest_challenge() in auth_utils.py.
 *
 * @param wwwAuthenticate
 * @throws Error if the header is not a Digest challenge or missing `nonce`
 */
export declare function parseDigestChallenge(wwwAuthenticate: string): DigestChallenge;
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
export declare function buildDigestHeader(method: string, url: string, username: string, password: string, challenge: DigestChallenge): string;
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
export declare function digestRequest(url: string, username: string, password: string, options?: DigestRequestOptions): Promise<DigestResponse>;
/**
 * Convenience wrapper: perform a GET request with Digest auth.
 *
 * @param url
 * @param username
 * @param password
 * @param options
 */
export declare function digestGet(url: string, username: string, password: string, options?: Omit<DigestRequestOptions, "method">): Promise<DigestResponse>;
/**
 * Convenience wrapper: perform a PUT request with Digest auth.
 *
 * @param url
 * @param username
 * @param password
 * @param data
 * @param options
 */
export declare function digestPut(url: string, username: string, password: string, data: string | Buffer, options?: Omit<DigestRequestOptions, "method" | "data">): Promise<DigestResponse>;
//# sourceMappingURL=digest.d.ts.map