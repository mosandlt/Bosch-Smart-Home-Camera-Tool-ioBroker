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
/**
 * Start a local TLS proxy that exposes a Bosch RTSPS endpoint as plain RTSP
 * on localhost. go2rtc / FFmpeg can then connect to rtsp://127.0.0.1:PORT/...
 *
 * Returns a TlsProxyHandle with the chosen port and a stop() method.
 */
export declare function startTlsProxy(options: TlsProxyOptions): Promise<TlsProxyHandle>;
//# sourceMappingURL=tls_proxy.d.ts.map