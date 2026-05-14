/**
 * RTSP-aware Digest auth proxy helper.
 *
 * Bosch cameras protect their RTSP endpoint with Digest auth. Some clients
 * (notably BlueIris, forum #84538) refuse to parse credentials embedded in
 * the URL (`rtsp://user:pass@host/...`) — they strip them into separate
 * config fields and either skip the Digest challenge entirely or send a
 * malformed Authorization header. Result: HTTP 401 / `Error 8000007a`.
 *
 * This module makes the TLS proxy speak RTSP: when a client connects
 * WITHOUT an `Authorization:` header in its first request, the proxy itself
 * performs the Digest dance against the camera:
 *
 *   1. Forward the unauthenticated first request to the camera
 *   2. Camera replies `401 Unauthorized + WWW-Authenticate: Digest …`
 *   3. Proxy parses the challenge, computes the response, rewrites the
 *      original request with an `Authorization:` header, and resends
 *   4. Camera replies `200 OK` — proxy forwards to the client
 *   5. From now on every client→camera request is rewritten with a fresh
 *      Authorization header (nonce reused; RFC 7616 allows that)
 *
 * Back-compat: when the client DOES send `Authorization:` in its first
 * request (e.g. VLC + in-URL creds, the legacy v0.5.x behaviour), the
 * proxy switches to passthrough mode and never touches the bytes again.
 * Old URLs keep working.
 *
 * Camera→client direction is always byte-piped (except during the auth
 * dance) — RTP frames are interleaved with `$` markers after PLAY and
 * we don't need to parse them.
 */
import type * as net from "node:net";
import type * as tls from "node:tls";
/** Options for {@link attachRtspAuthHandler}. */
export interface RtspAuthOptions {
    /**
     *
     */
    clientSocket: net.Socket;
    /**
     *
     */
    remoteSocket: tls.TLSSocket;
    /** Digest username (from the Bosch session). */
    digestUser: string;
    /** Digest password (from the Bosch session). */
    digestPassword: string;
    /** Adapter log function. */
    log: (level: "debug" | "info" | "warn" | "error", message: string) => void;
    /** Short cam label for log lines. */
    camLabel: string;
}
/**
 * Attach the auth-aware proxy logic to an existing TLS connection pair.
 *
 * Replaces the simple `pipe()` byte-forwarder with a state-machine that:
 *   - Detects whether the client sends in-URL Digest creds (back-compat
 *     passthrough) or expects the proxy to handle auth (inject mode)
 *   - In inject mode: does the 401 dance once, then rewrites every
 *     subsequent client→remote RTSP request with a fresh Authorization
 *     header. Camera→client direction is byte-piped.
 *
 * Caller must still install `error` / `end` / `close` teardown listeners
 * on both sockets — this helper only owns the `data` flow.
 *
 * @param opts
 */
export declare function attachRtspAuthHandler(opts: RtspAuthOptions): void;
/**
 * Return the byte offset right after `\r\n\r\n`, or -1 if not present.
 *
 * @param buf
 */
export declare function findRtspMessageEnd(buf: Buffer): number;
/**
 * Parse `METHOD uri RTSP/1.0` from the first line. Returns null on parse error.
 *
 * @param buf
 */
export declare function parseRequestStartLine(buf: Buffer): {
    method: string;
    uri: string;
} | null;
/**
 * Parse the numeric status code from a `RTSP/1.0 NNN PHRASE` start line.
 *
 * @param buf
 */
export declare function parseResponseStatus(buf: Buffer): number | null;
/**
 * Pull the first `WWW-Authenticate:` header value out of an RTSP response.
 * Header names are case-insensitive per RFC 7826.
 *
 * @param buf
 */
export declare function extractWwwAuthenticate(buf: Buffer): string | null;
/**
 * True if the request headers contain an `Authorization:` line.
 *
 * @param buf
 */
export declare function hasAuthorizationHeader(buf: Buffer): boolean;
/**
 * Insert an `Authorization: <value>` header immediately before the empty
 * line that terminates the request headers. Caller has verified the buffer
 * is a complete RTSP message (ends with `\r\n\r\n`).
 *
 * @param request
 * @param authValue
 */
export declare function injectAuthHeader(request: Buffer, authValue: string): Buffer;
//# sourceMappingURL=rtsp_auth.d.ts.map