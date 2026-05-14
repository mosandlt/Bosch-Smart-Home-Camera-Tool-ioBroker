"use strict";
/**
 * TLS Proxy for Bosch Smart Home Camera RTSPS streams.
 *
 * Bosch cameras expose RTSPS (RTSP-over-TLS) with a private CA certificate
 * that FFmpeg/go2rtc can't handle directly. This module creates a local TCP
 * server that accepts plain RTSP connections and forwards them over TLS to the
 * camera — stripping TLS from the consumer's perspective.
 *
 * Architecture (Node.js vs Python original):
 *   Python: threading.Thread + socket.select() + ssl.wrap_socket() per connection
 *   Node.js: net.createServer() + tls.connect() + stream.pipe() — no threads needed;
 *            Node's event loop and stream backpressure handle concurrency natively.
 *
 * Circuit breaker: after _MAX_BURST consecutive connect failures within
 * _BURST_WINDOW seconds, the server socket is closed. The coordinator must
 * rebuild the session when the camera becomes reachable again.
 *
 * Port of Python tls_proxy.py (Bosch-Smart-Home-Camera-Tool-HomeAssistant).
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.startTlsProxy = startTlsProxy;
const net = __importStar(require("node:net"));
const tls = __importStar(require("node:tls"));
// ── Constants (mirrors Python tls_proxy.py) ───────────────────────────────────
const _MAX_BURST = 5; // consecutive failures before closing server
const _BURST_WINDOW = 30_000; // ms — window for burst counting
// ── Implementation ────────────────────────────────────────────────────────────
/**
 * Start a local TLS proxy that exposes a Bosch RTSPS endpoint as plain RTSP
 * on localhost. go2rtc / FFmpeg can then connect to rtsp://127.0.0.1:PORT/...
 *
 * Returns a TlsProxyHandle with the chosen port and a stop() method.
 *
 * @param options
 */
function startTlsProxy(options) {
    return new Promise((resolve, reject) => {
        const { remoteHost, remotePort, cameraId, localPort = 0, bindHost = "127.0.0.1", urlHost, rejectUnauthorized = false, } = options;
        const camLabel = cameraId.slice(0, 8);
        const log = options.log ?? (() => undefined);
        // Track all live sockets so stop() can destroy them
        const activeSockets = new Set();
        // Circuit-breaker state (mirrors Python fail_count / first_fail_at)
        let failCount = 0;
        let firstFailAt = 0; // Date.now() ms
        const server = net.createServer((clientSocket) => {
            // Keep-alive on the client (FFmpeg) side
            clientSocket.setKeepAlive(true, 30_000);
            activeSockets.add(clientSocket);
            log("debug", `TLS proxy ${camLabel}: client connected`);
            // Open TLS connection to remote (camera / relay)
            const remoteSocket = tls.connect({
                host: remoteHost,
                port: remotePort,
                rejectUnauthorized,
            });
            activeSockets.add(remoteSocket);
            // ── Teardown helper — close both ends ───────────────────────────
            let closed = false;
            function teardown(reason) {
                if (closed) {
                    return;
                }
                closed = true;
                log("debug", `TLS proxy ${camLabel}: teardown — ${reason}`);
                if (!clientSocket.destroyed) {
                    clientSocket.destroy();
                }
                if (!remoteSocket.destroyed) {
                    remoteSocket.destroy();
                }
                activeSockets.delete(clientSocket);
                activeSockets.delete(remoteSocket);
            }
            // ── Remote socket event handlers ────────────────────────────────
            remoteSocket.on("secureConnect", () => {
                const cipher = remoteSocket.getCipher();
                const proto = remoteSocket.getProtocol();
                log("debug", `TLS proxy ${camLabel}: connected to ${remoteHost}:${remotePort}` +
                    ` (${proto ?? "?"}, ${cipher?.name ?? "?"})`);
                // Reset circuit-breaker on successful connect
                failCount = 0;
                firstFailAt = 0;
                // Keep-alive on camera side too
                remoteSocket.setKeepAlive(true, 30_000);
                // Bidirectional pipe: client ↔ remote
                // pipe() sets up data event listeners and handles backpressure
                clientSocket.pipe(remoteSocket);
                remoteSocket.pipe(clientSocket);
            });
            remoteSocket.on("error", (err) => {
                const now = Date.now();
                if (failCount === 0) {
                    firstFailAt = now;
                }
                failCount++;
                log("warn", `TLS proxy ${camLabel}: failed to connect to ${remoteHost}:${remotePort} — ${err.message}`);
                teardown(`remote error: ${err.message}`);
                // Circuit breaker: too many failures in a short window
                if (failCount >= _MAX_BURST && now - firstFailAt <= _BURST_WINDOW) {
                    log("warn", `TLS proxy ${camLabel}: ${failCount} consecutive connect failures` +
                        ` in ${Math.round((now - firstFailAt) / 1000)}s —` +
                        ` closing server socket (camera unreachable).` +
                        ` Coordinator will rebuild the session when the camera is back.`);
                    server.close();
                    activeSockets.clear();
                }
            });
            remoteSocket.on("end", () => teardown("remote end"));
            remoteSocket.on("close", () => teardown("remote close"));
            // ── Client socket event handlers ────────────────────────────────
            clientSocket.on("error", (err) => {
                log("debug", `TLS proxy ${camLabel}: client socket error — ${err.message}`);
                teardown(`client error: ${err.message}`);
            });
            clientSocket.on("end", () => teardown("client end"));
            clientSocket.on("close", () => teardown("client close"));
        });
        // ── Server error (e.g. EADDRINUSE) ─────────────────────────────────
        server.on("error", (err) => {
            log("error", `TLS proxy ${camLabel}: server error — ${err.message}`);
            // If we haven't resolved yet, reject. Otherwise log only.
            reject(err);
        });
        // ── Start listening ─────────────────────────────────────────────────
        server.listen(localPort, bindHost, () => {
            const addr = server.address();
            const port = addr.port;
            // Pick the host that will be embedded in the public URL: explicit
            // urlHost > bindHost (but never "0.0.0.0", which is unroutable).
            const publicHost = urlHost && urlHost.length > 0
                ? urlHost
                : bindHost === "0.0.0.0"
                    ? "127.0.0.1"
                    : bindHost;
            const localRtspUrl = `rtsp://${publicHost}:${port}/rtsp_tunnel`;
            log("info", `TLS proxy for ${camLabel} started on ${bindHost}:${port}` +
                ` -> ${remoteHost}:${remotePort}`);
            // ── stop() implementation ───────────────────────────────────────
            function stop() {
                return new Promise((res) => {
                    log("debug", `TLS proxy ${camLabel}: stopping`);
                    // Destroy all live sockets first
                    for (const sock of activeSockets) {
                        if (!sock.destroyed) {
                            sock.destroy();
                        }
                    }
                    activeSockets.clear();
                    server.close(() => {
                        log("debug", `TLS proxy ${camLabel}: server socket closed`);
                        res();
                    });
                    // If no connections are open, close() callback fires immediately.
                    // With in-flight connections already destroyed above, this should
                    // complete synchronously on the next tick.
                });
            }
            resolve({ port, bindHost, localRtspUrl, stop });
        });
    });
}
//# sourceMappingURL=tls_proxy.js.map