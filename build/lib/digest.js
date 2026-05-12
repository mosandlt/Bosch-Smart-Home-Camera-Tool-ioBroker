"use strict";
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
exports.parseDigestChallenge = parseDigestChallenge;
exports.buildDigestHeader = buildDigestHeader;
exports.digestRequest = digestRequest;
exports.digestGet = digestGet;
exports.digestPut = digestPut;
const crypto = __importStar(require("crypto"));
const https = __importStar(require("https"));
const axios_1 = __importDefault(require("axios"));
// ── Internal helpers ──────────────────────────────────────────────────────────
/**
 * Compute MD5 hex digest of a UTF-8 string.
 * Mirrors Python _md5() in auth_utils.py.
 */
function md5(input) {
    return crypto.createHash("md5").update(input, "utf-8").digest("hex");
}
/**
 * Compute SHA-256 hex digest of a UTF-8 string.
 * Mirrors Python _sha256() in auth_utils.py.
 */
function sha256(input) {
    return crypto.createHash("sha256").update(input, "utf-8").digest("hex");
}
/**
 * Select the hash function based on the Digest algorithm directive.
 * Defaults to MD5 if algorithm is absent or unrecognized.
 */
function selectHashFn(algorithm) {
    const alg = (algorithm ?? "MD5").toUpperCase();
    if (alg.startsWith("SHA-256"))
        return sha256;
    return md5;
}
/**
 * Parse the WWW-Authenticate: Digest header into a DigestChallenge object.
 * Mirrors Python _parse_digest_challenge() in auth_utils.py.
 *
 * @throws Error if the header is not a Digest challenge or missing `nonce`
 */
function parseDigestChallenge(wwwAuthenticate) {
    const [scheme, ...rest] = wwwAuthenticate.trim().split(/\s+/);
    if (scheme.toLowerCase() !== "digest") {
        throw new Error(`Expected Digest scheme, got: ${scheme}`);
    }
    const paramsStr = rest.join(" ");
    const params = {};
    // Match key=value or key="value" pairs (same regex as Python port)
    const re = /(\w+)=(?:"([^"]*)"|([^,\s]+))/g;
    let match;
    while ((match = re.exec(paramsStr)) !== null) {
        const key = match[1].toLowerCase();
        const value = match[2] !== undefined ? match[2] : match[3];
        params[key] = value;
    }
    if (!params["nonce"]) {
        throw new Error("Digest challenge missing required 'nonce' directive");
    }
    return {
        realm: params["realm"] ?? "",
        nonce: params["nonce"],
        opaque: params["opaque"],
        qop: params["qop"],
        algorithm: params["algorithm"],
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
function buildDigestHeader(method, url, username, password, challenge) {
    const { realm, nonce, opaque, qop, algorithm } = challenge;
    const hash = selectHashFn(algorithm);
    const alg = (algorithm ?? "MD5").toUpperCase();
    // Extract URI path (+ query) from full URL — RFC 7616 §3.4 digest-uri
    let uri;
    try {
        const parsed = new URL(url);
        uri = parsed.pathname + (parsed.search ?? "");
    }
    catch {
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
    let response;
    if (qopValue === "auth") {
        response = hash(`${ha1}:${nonce}:${nc}:${cnonce}:${qopValue}:${ha2}`);
    }
    else {
        // Legacy: no qop
        response = hash(`${ha1}:${nonce}:${ha2}`);
    }
    // Build header parts
    const parts = [
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
    return "Digest " + parts.join(", ");
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
 *
 * @throws Error    If 401 response has no WWW-Authenticate or missing nonce
 * @throws Error    On network-level errors (propagated from axios)
 */
async function digestRequest(url, username, password, options = {}) {
    const method = options.method ?? "GET";
    const timeout = options.timeout ?? 10_000;
    const rejectUnauthorized = options.rejectUnauthorized ?? false;
    const httpsAgent = new https.Agent({ rejectUnauthorized });
    const axiosOpts = {
        method,
        url,
        httpsAgent,
        timeout,
        responseType: "arraybuffer",
        validateStatus: () => true, // handle all status codes manually
        headers: { ...(options.headers ?? {}) },
        ...(options.data !== undefined ? { data: options.data } : {}),
    };
    // Step 1: Initial request without Authorization
    const firstResp = await (0, axios_1.default)(axiosOpts);
    if (firstResp.status !== 401) {
        return {
            status: firstResp.status,
            headers: firstResp.headers,
            data: Buffer.from(firstResp.data),
        };
    }
    // Step 2: Parse 401 challenge
    const wwwAuth = firstResp.headers["www-authenticate"] ?? "";
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
    const secondResp = await (0, axios_1.default)(authOpts);
    return {
        status: secondResp.status,
        headers: secondResp.headers,
        data: Buffer.from(secondResp.data),
    };
}
/**
 * Convenience wrapper: perform a GET request with Digest auth.
 */
async function digestGet(url, username, password, options) {
    return digestRequest(url, username, password, { ...options, method: "GET" });
}
/**
 * Convenience wrapper: perform a PUT request with Digest auth.
 */
async function digestPut(url, username, password, data, options) {
    return digestRequest(url, username, password, {
        ...options,
        method: "PUT",
        data,
    });
}
//# sourceMappingURL=digest.js.map