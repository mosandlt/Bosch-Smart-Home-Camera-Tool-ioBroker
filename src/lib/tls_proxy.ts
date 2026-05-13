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

import * as net from "net";
import * as tls from "tls";

// ── Public types ──────────────────────────────────────────────────────────────

/** Handle returned by startTlsProxy() */
export interface TlsProxyHandle {
    /** Local port the proxy is listening on */
    port: number;
    /** Plain-RTSP URL clients should connect to */
    localRtspUrl: string;
    /** Stop the proxy (close server + all in-flight connections) */
    stop(): Promise<void>;
}

/** Options for startTlsProxy() */
export interface TlsProxyOptions {
    /** Remote host (e.g. "proxy-12.live.cbs.boschsecurity.com" or LAN IP) */
    remoteHost: string;
    /** Remote port (typically 42090 for cloud-proxy, 443 for LAN) */
    remotePort: number;
    /** Camera ID for log labelling */
    cameraId: string;
    /** Bound local port (0 = pick free port, returned in handle.port) */
    localPort?: number;
    /**
     * Logger function — pass adapter's this.log.debug / info / warn / error.
     * Defaults to a no-op if omitted.
     */
    log?: (level: "debug" | "info" | "warn" | "error", message: string) => void;
    /**
     * Whether to reject expired / self-signed certificates.
     * Default false — Bosch cameras use a private CA.
     */
    rejectUnauthorized?: boolean;
}

// ── Constants (mirrors Python tls_proxy.py) ───────────────────────────────────

const _MAX_BURST = 5;        // consecutive failures before closing server
const _BURST_WINDOW = 30_000; // ms — window for burst counting

// ── Implementation ────────────────────────────────────────────────────────────

/**
 * Start a local TLS proxy that exposes a Bosch RTSPS endpoint as plain RTSP
 * on localhost. go2rtc / FFmpeg can then connect to rtsp://127.0.0.1:PORT/...
 *
 * Returns a TlsProxyHandle with the chosen port and a stop() method.
 */
export function startTlsProxy(options: TlsProxyOptions): Promise<TlsProxyHandle> {
    return new Promise((resolve, reject) => {
        const {
            remoteHost,
            remotePort,
            cameraId,
            localPort = 0,
            rejectUnauthorized = false,
        } = options;

        const camLabel = cameraId.slice(0, 8);
        const log = options.log ?? (() => undefined);

        // Track all live sockets so stop() can destroy them
        const activeSockets = new Set<net.Socket | tls.TLSSocket>();

        // Circuit-breaker state (mirrors Python fail_count / first_fail_at)
        let failCount = 0;
        let firstFailAt = 0; // Date.now() ms

        const server = net.createServer((clientSocket: net.Socket) => {
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
            function teardown(reason: string): void {
                if (closed) return;
                closed = true;
                log("debug", `TLS proxy ${camLabel}: teardown — ${reason}`);
                if (!clientSocket.destroyed) clientSocket.destroy();
                if (!remoteSocket.destroyed) remoteSocket.destroy();
                activeSockets.delete(clientSocket);
                activeSockets.delete(remoteSocket);
            }

            // ── Remote socket event handlers ────────────────────────────────
            remoteSocket.on("secureConnect", () => {
                const cipher = remoteSocket.getCipher();
                const proto = remoteSocket.getProtocol();
                log(
                    "debug",
                    `TLS proxy ${camLabel}: connected to ${remoteHost}:${remotePort}` +
                    ` (${proto ?? "?"}, ${cipher?.name ?? "?"})`,
                );

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

            remoteSocket.on("error", (err: Error) => {
                const now = Date.now();
                if (failCount === 0) firstFailAt = now;
                failCount++;

                log(
                    "warn",
                    `TLS proxy ${camLabel}: failed to connect to ${remoteHost}:${remotePort} — ${err.message}`,
                );
                teardown(`remote error: ${err.message}`);

                // Circuit breaker: too many failures in a short window
                if (failCount >= _MAX_BURST && (now - firstFailAt) <= _BURST_WINDOW) {
                    log(
                        "warn",
                        `TLS proxy ${camLabel}: ${failCount} consecutive connect failures` +
                        ` in ${Math.round((now - firstFailAt) / 1000)}s —` +
                        ` closing server socket (camera unreachable).` +
                        ` Coordinator will rebuild the session when the camera is back.`,
                    );
                    server.close();
                    activeSockets.clear();
                }
            });

            remoteSocket.on("end", () => teardown("remote end"));
            remoteSocket.on("close", () => teardown("remote close"));

            // ── Client socket event handlers ────────────────────────────────
            clientSocket.on("error", (err: Error) => {
                log("debug", `TLS proxy ${camLabel}: client socket error — ${err.message}`);
                teardown(`client error: ${err.message}`);
            });

            clientSocket.on("end", () => teardown("client end"));
            clientSocket.on("close", () => teardown("client close"));
        });

        // ── Server error (e.g. EADDRINUSE) ─────────────────────────────────
        server.on("error", (err: Error) => {
            log("error", `TLS proxy ${camLabel}: server error — ${err.message}`);
            // If we haven't resolved yet, reject. Otherwise log only.
            reject(err);
        });

        // ── Start listening ─────────────────────────────────────────────────
        server.listen(localPort, "127.0.0.1", () => {
            const addr = server.address() as net.AddressInfo;
            const port = addr.port;
            const localRtspUrl = `rtsp://127.0.0.1:${port}/rtsp_tunnel`;

            log(
                "info",
                `TLS proxy for ${camLabel} started on 127.0.0.1:${port}` +
                ` -> ${remoteHost}:${remotePort}`,
            );

            // ── stop() implementation ───────────────────────────────────────
            function stop(): Promise<void> {
                return new Promise((res) => {
                    log("debug", `TLS proxy ${camLabel}: stopping`);

                    // Destroy all live sockets first
                    for (const sock of activeSockets) {
                        if (!sock.destroyed) sock.destroy();
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

            resolve({ port, localRtspUrl, stop });
        });
    });
}
