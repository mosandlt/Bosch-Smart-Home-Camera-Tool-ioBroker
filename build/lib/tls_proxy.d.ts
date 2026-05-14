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
/**
 * Start a local TLS proxy that exposes a Bosch RTSPS endpoint as plain RTSP
 * on localhost. go2rtc / FFmpeg can then connect to rtsp://127.0.0.1:PORT/...
 *
 * Returns a TlsProxyHandle with the chosen port and a stop() method.
 *
 * @param options
 */
export declare function startTlsProxy(options: TlsProxyOptions): Promise<TlsProxyHandle>;
//# sourceMappingURL=tls_proxy.d.ts.map