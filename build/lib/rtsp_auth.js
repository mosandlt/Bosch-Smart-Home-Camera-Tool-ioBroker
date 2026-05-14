"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.attachRtspAuthHandler = attachRtspAuthHandler;
exports.findRtspMessageEnd = findRtspMessageEnd;
exports.parseRequestStartLine = parseRequestStartLine;
exports.parseResponseStatus = parseResponseStatus;
exports.extractWwwAuthenticate = extractWwwAuthenticate;
exports.hasAuthorizationHeader = hasAuthorizationHeader;
exports.injectAuthHeader = injectAuthHeader;
const digest_1 = require("./digest");
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
function attachRtspAuthHandler(opts) {
    const { clientSocket, remoteSocket, digestUser, digestPassword, log, camLabel } = opts;
    let mode = "DETECTING";
    let clientBuf = Buffer.alloc(0);
    let remoteBuf = Buffer.alloc(0);
    let pendingFirstRequest = null;
    let challenge = null;
    // ── Client → Remote ───────────────────────────────────────────────────────
    clientSocket.on("data", (chunk) => {
        if (mode === "PASSTHROUGH") {
            remoteSocket.write(chunk);
            return;
        }
        if (mode === "AUTH_NEED" || mode === "AUTH_RESPONDING") {
            // Buffer client data until the auth dance completes — RTSP clients
            // wait for a response before sending the next request, so this is
            // typically empty. Replay once we reach INJECTING.
            clientBuf = Buffer.concat([clientBuf, chunk]);
            return;
        }
        // DETECTING or INJECTING: parse request-by-request
        clientBuf = Buffer.concat([clientBuf, chunk]);
        processClientBuffer();
    });
    function processClientBuffer() {
        while (clientBuf.length > 0) {
            const end = findRtspMessageEnd(clientBuf);
            if (end < 0) {
                return; // incomplete — wait for more bytes
            }
            const reqBuf = clientBuf.slice(0, end);
            clientBuf = clientBuf.slice(end);
            if (mode === "DETECTING") {
                if (hasAuthorizationHeader(reqBuf)) {
                    // Back-compat: client already authenticates itself.
                    mode = "PASSTHROUGH";
                    log("debug", `RTSP auth ${camLabel}: client uses in-URL creds, passthrough`);
                    remoteSocket.write(reqBuf);
                    if (clientBuf.length > 0) {
                        remoteSocket.write(clientBuf);
                        clientBuf = Buffer.alloc(0);
                    }
                    return;
                }
                // No auth — start auth dance: send unchanged, wait for 401
                pendingFirstRequest = reqBuf;
                mode = "AUTH_NEED";
                log("debug", `RTSP auth ${camLabel}: probing camera for Digest challenge`);
                remoteSocket.write(reqBuf);
                return; // anything after this is buffered for replay
            }
            // INJECTING mode
            const parsed = parseRequestStartLine(reqBuf);
            if (parsed && challenge) {
                try {
                    const authHeader = (0, digest_1.buildDigestHeader)(parsed.method, parsed.uri, digestUser, digestPassword, challenge);
                    remoteSocket.write(injectAuthHeader(reqBuf, authHeader));
                    continue;
                }
                catch (err) {
                    log("debug", `RTSP auth ${camLabel}: header injection failed, forwarding raw — ` +
                        `${err instanceof Error ? err.message : String(err)}`);
                }
            }
            // Fallback: forward unchanged
            remoteSocket.write(reqBuf);
        }
    }
    // ── Remote → Client ───────────────────────────────────────────────────────
    remoteSocket.on("data", (chunk) => {
        if (mode === "AUTH_NEED" || mode === "AUTH_RESPONDING") {
            remoteBuf = Buffer.concat([remoteBuf, chunk]);
            const end = findRtspMessageEnd(remoteBuf);
            if (end < 0) {
                return; // need full response headers
            }
            const respBuf = remoteBuf.slice(0, end);
            const trailing = remoteBuf.slice(end);
            remoteBuf = Buffer.alloc(0);
            const status = parseResponseStatus(respBuf);
            if (mode === "AUTH_NEED" && status === 401 && pendingFirstRequest) {
                const wwwAuth = extractWwwAuthenticate(respBuf);
                if (wwwAuth) {
                    try {
                        challenge = (0, digest_1.parseDigestChallenge)(wwwAuth);
                    }
                    catch (err) {
                        log("warn", `RTSP auth ${camLabel}: failed to parse WWW-Authenticate, ` +
                            `forwarding 401 to client — ` +
                            `${err instanceof Error ? err.message : String(err)}`);
                        challenge = null;
                    }
                }
                if (challenge) {
                    const parsed = parseRequestStartLine(pendingFirstRequest);
                    if (parsed) {
                        const authHeader = (0, digest_1.buildDigestHeader)(parsed.method, parsed.uri, digestUser, digestPassword, challenge);
                        const authed = injectAuthHeader(pendingFirstRequest, authHeader);
                        mode = "AUTH_RESPONDING";
                        log("debug", `RTSP auth ${camLabel}: got 401, resent with Digest`);
                        remoteSocket.write(authed);
                        // 401 is SWALLOWED — never forwarded to client.
                        if (trailing.length > 0) {
                            // Process any extra response bytes that came in the same chunk
                            remoteBuf = trailing;
                            // Re-trigger handler logic via setImmediate to avoid recursion
                            setImmediate(() => remoteSocket.emit("data", Buffer.alloc(0)));
                        }
                        return;
                    }
                }
                // Couldn't compute auth — abort, forward 401 so client knows
                log("warn", `RTSP auth ${camLabel}: cannot compute Digest, forwarding 401 to client`);
                mode = "PASSTHROUGH";
                clientSocket.write(respBuf);
                if (trailing.length > 0) {
                    clientSocket.write(trailing);
                }
                if (clientBuf.length > 0) {
                    remoteSocket.write(clientBuf);
                    clientBuf = Buffer.alloc(0);
                }
                return;
            }
            if (mode === "AUTH_RESPONDING") {
                // Response to our authed retry — forward to client and switch to INJECTING.
                mode = "INJECTING";
                pendingFirstRequest = null;
                log("debug", `RTSP auth ${camLabel}: auth dance done (status ${status ?? "?"}), ` +
                    `entering INJECTING mode`);
                clientSocket.write(respBuf);
                if (trailing.length > 0) {
                    clientSocket.write(trailing);
                }
                // Replay any client requests that arrived while we were dancing
                if (clientBuf.length > 0) {
                    processClientBuffer();
                }
                return;
            }
            // Other status during auth dance — just forward and try to continue
            clientSocket.write(respBuf);
            if (trailing.length > 0) {
                clientSocket.write(trailing);
            }
            return;
        }
        // PASSTHROUGH or INJECTING — byte-pipe remote → client
        clientSocket.write(chunk);
    });
}
// ── Pure helpers (exported for tests) ─────────────────────────────────────────
/**
 * Return the byte offset right after `\r\n\r\n`, or -1 if not present.
 *
 * @param buf
 */
function findRtspMessageEnd(buf) {
    const i = buf.indexOf("\r\n\r\n");
    return i >= 0 ? i + 4 : -1;
}
/**
 * Parse `METHOD uri RTSP/1.0` from the first line. Returns null on parse error.
 *
 * @param buf
 */
function parseRequestStartLine(buf) {
    const eol = buf.indexOf("\r\n");
    const firstLine = (eol >= 0 ? buf.slice(0, eol) : buf).toString("utf-8");
    const m = firstLine.match(/^([A-Z_]+)\s+(\S+)\s+RTSP\/\d/);
    return m ? { method: m[1], uri: m[2] } : null;
}
/**
 * Parse the numeric status code from a `RTSP/1.0 NNN PHRASE` start line.
 *
 * @param buf
 */
function parseResponseStatus(buf) {
    const eol = buf.indexOf("\r\n");
    const firstLine = (eol >= 0 ? buf.slice(0, eol) : buf).toString("utf-8");
    const m = firstLine.match(/^RTSP\/[\d.]+\s+(\d+)/);
    return m ? parseInt(m[1], 10) : null;
}
/**
 * Pull the first `WWW-Authenticate:` header value out of an RTSP response.
 * Header names are case-insensitive per RFC 7826.
 *
 * @param buf
 */
function extractWwwAuthenticate(buf) {
    const text = buf.toString("utf-8");
    const m = text.match(/(?:^|\r\n)WWW-Authenticate\s*:\s*([^\r\n]+)/i);
    return m ? m[1].trim() : null;
}
/**
 * True if the request headers contain an `Authorization:` line.
 *
 * @param buf
 */
function hasAuthorizationHeader(buf) {
    return /(?:^|\r\n)Authorization\s*:/i.test(buf.toString("utf-8"));
}
/**
 * Insert an `Authorization: <value>` header immediately before the empty
 * line that terminates the request headers. Caller has verified the buffer
 * is a complete RTSP message (ends with `\r\n\r\n`).
 *
 * @param request
 * @param authValue
 */
function injectAuthHeader(request, authValue) {
    const text = request.toString("utf-8");
    const sep = text.indexOf("\r\n\r\n");
    if (sep < 0) {
        return request; // shouldn't happen — caller checks
    }
    const head = text.slice(0, sep);
    const tail = text.slice(sep);
    return Buffer.from(`${head}\r\nAuthorization: ${authValue}${tail}`, "utf-8");
}
//# sourceMappingURL=rtsp_auth.js.map