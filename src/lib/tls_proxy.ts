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

import * as net from "node:net";
import * as tls from "node:tls";

import { attachRtspAuthHandler } from "./rtsp_auth";

// ── Public types ──────────────────────────────────────────────────────────────

/** Handle returned by startTlsProxy() */
export interface TlsProxyHandle {
    /** Local port the proxy is listening on */
    port: number;
    /** Host the proxy is bound to (e.g. "127.0.0.1" or "0.0.0.0") */
    bindHost: string;
    /** Plain-RTSP URL clients should connect to (sans credentials) */
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
     * Host to bind the listener to.
     * Default "127.0.0.1" — only the local ioBroker host can connect.
     * Set to "0.0.0.0" (or a specific NIC IP) to expose to the LAN so an
     * external recorder (BlueIris, Frigate) running on a different host can
     * pull the stream. Forum #84538.
     */
    bindHost?: string;
    /**
     * Hostname / IP that should appear in the returned `localRtspUrl`.
     * Defaults to `bindHost`. Set explicitly when binding 0.0.0.0 so the URL
     * uses the ioBroker host's LAN IP instead of "0.0.0.0".
     */
    urlHost?: string;
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
    /**
     * v0.5.3: when set, the proxy speaks RTSP and handles the Digest
     * auth dance against the camera itself. Clients that connect WITHOUT
     * `Authorization:` headers (BlueIris, iobroker.cameras, many NVRs)
     * see a clean 200 OK and never need to manage credentials. Clients
     * that already send `Authorization:` are byte-piped through (legacy
     * stream_url with in-URL creds keeps working).
     *
     * Pass the same Digest credentials Bosch returned for the live
     * session (`session.digestUser` / `session.digestPassword`).
     * When omitted, the proxy reverts to a pure byte-pipe — equivalent
     * to v0.5.2 behaviour.
     */
    digestAuth?: {
        user: string;
        password: string;
    };
}

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
export function startTlsProxy(options: TlsProxyOptions): Promise<TlsProxyHandle> {
    return new Promise((resolve, reject) => {
        const {
            remoteHost,
            remotePort,
            cameraId,
            localPort = 0,
            bindHost = "127.0.0.1",
            urlHost,
            rejectUnauthorized = false,
            digestAuth,
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

                if (digestAuth) {
                    // v0.5.3: auth-aware mode — parse RTSP traffic, inject
                    // `Authorization: Digest …` headers transparently so
                    // clients can connect to a no-creds URL (fixes BlueIris
                    // Error 8000007a, forum #84538). Back-compat: when the
                    // client supplies its own Authorization (legacy in-URL
                    // creds path), the handler switches to passthrough.
                    attachRtspAuthHandler({
                        clientSocket,
                        remoteSocket,
                        digestUser: digestAuth.user,
                        digestPassword: digestAuth.password,
                        log,
                        camLabel,
                    });
                } else {
                    // Bidirectional byte-pipe: client ↔ remote.
                    // pipe() sets up data event listeners and handles backpressure.
                    clientSocket.pipe(remoteSocket);
                    remoteSocket.pipe(clientSocket);
                }
            });

            remoteSocket.on("error", (err: Error) => {
                const now = Date.now();
                if (failCount === 0) {
                    firstFailAt = now;
                }
                failCount++;

                log(
                    "warn",
                    `TLS proxy ${camLabel}: failed to connect to ${remoteHost}:${remotePort} — ${err.message}`,
                );
                teardown(`remote error: ${err.message}`);

                // Circuit breaker: too many failures in a short window
                if (failCount >= _MAX_BURST && now - firstFailAt <= _BURST_WINDOW) {
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
        server.listen(localPort, bindHost, () => {
            const addr = server.address() as net.AddressInfo;
            const port = addr.port;
            // Pick the host that will be embedded in the public URL: explicit
            // urlHost > bindHost (but never "0.0.0.0", which is unroutable).
            const publicHost =
                urlHost && urlHost.length > 0
                    ? urlHost
                    : bindHost === "0.0.0.0"
                      ? "127.0.0.1"
                      : bindHost;
            const localRtspUrl = `rtsp://${publicHost}:${port}/rtsp_tunnel`;

            log(
                "info",
                `TLS proxy for ${camLabel} started on ${bindHost}:${port}` +
                    ` -> ${remoteHost}:${remotePort}`,
            );

            // ── stop() implementation ───────────────────────────────────────
            function stop(): Promise<void> {
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
