/**
 * Bosch Cloud Live-Session opener — LOCAL only.
 *
 * Opens a per-camera proxy session via:
 *   PUT https://residential.cbs.boschsecurity.com/v11/video_inputs/{id}/connection
 *
 * Response shape (LOCAL, 200/201):
 *   { "user": "cbs-XXXXXX", "password": "...", "urls": ["192.168.x.x:443"],
 *     "imageUrlScheme": "https://{url}/snap.jpg", "bufferingTime": 500,
 *     "maxSessionDuration": 3600, ... }
 *
 * DESIGN CONSTRAINT (v0.4.0): This adapter NEVER uses Bosch's cloud media relay
 * (proxy-NN.live.cbs.boschsecurity.com:42090). Cloud REST calls for login /
 * discovery / control are fine — only media paths must go LOCAL.
 * If Bosch returns a non-LOCAL session, an error is thrown.
 *
 * Error codes:
 *   401 → token expired (caller must refresh and retry)
 *   444 → session quota hit (SessionLimitError)
 *   other non-2xx → LiveSessionError
 *
 * Reference: HA custom_components/bosch_shc_camera/__init__.py
 *   try_live_connection() / _try_live_connection_inner() ~L2299–2826
 *
 * Close: DELETE same URL (best-effort — 404 = already closed, no throw).
 */
import type { AxiosInstance } from "axios";
/**
 * Thrown on 5xx / network / malformed-response errors from the connection
 * endpoint. The session was not established.
 */
export declare class LiveSessionError extends Error {
    readonly cause?: unknown;
    constructor(message: string, cause?: unknown);
}
/**
 * Thrown when the camera is offline or privacy mode is on (Bosch returns
 * HTTP 503 or 444 with the body "sh:camera.in.privacy.mode" for privacy,
 * and HTTP 503 for genuine offline). Callers should stop retrying until
 * the camera comes back online.
 */
export declare class CameraOfflineError extends Error {
    constructor(message: string);
}
/**
 * Thrown when Bosch returns HTTP 444 (session quota hit).
 * The caller should back off and retry after closing unused sessions.
 */
export declare class SessionLimitError extends Error {
    constructor(message: string);
}
/** Result of a successful openLiveSession() call. Always LOCAL. */
export interface LiveSession {
    /** UUID of the camera (echoed back from the call arguments). */
    cameraId: string;
    /**
     * Full snapshot URL.
     * Always LOCAL: https://<lan-ip>:443/snap.jpg?JpegSize=1206
     */
    proxyUrl: string;
    /**
     * Connection type — always "LOCAL" in this adapter.
     * Cloud relay paths are removed by design (v0.4.0).
     */
    readonly connectionType: "LOCAL";
    /**
     * Digest username for LOCAL connections (e.g. "cbs-57355237").
     */
    digestUser: string;
    /**
     * Digest password for LOCAL connections.
     */
    digestPassword: string;
    /**
     * LAN address returned by Bosch for LOCAL connections (e.g. "192.0.2.10:443").
     */
    lanAddress: string;
    /**
     * Session lifetime hint in milliseconds (from Bosch "bufferingTime" field).
     * Typical: 500 ms for LOCAL connections.
     */
    bufferingTimeMs: number;
    /**
     * Maximum session duration in seconds (from Bosch "maxSessionDuration" field).
     * Default: 3600 s if absent in the response.
     * The RTSP watchdog uses this to schedule session renewal ~60 s before expiry.
     */
    maxSessionDuration: number;
    /** When this session was opened (Date.now() epoch ms). */
    openedAt: number;
}
/**
 * Open a LOCAL live proxy session for a camera.
 *
 * Calls PUT /v11/video_inputs/{cameraId}/connection with body:
 *   { "type": "LOCAL", "highQualityVideo": true }
 *
 * Returns a LiveSession containing the LOCAL proxyUrl (for snap.jpg / RCP+)
 * and Digest credentials.
 *
 * IMPORTANT: This adapter is LOCAL-only by design. If Bosch returns a
 * non-LOCAL session (e.g. because the camera is unreachable on the LAN),
 * a LiveSessionError is thrown. The cloud relay at
 * proxy-NN.live.cbs.boschsecurity.com:42090 is NEVER used for media.
 *
 * @param httpClient  Axios instance (caller controls SSL/timeout options)
 * @param token       Bearer access token
 * @param cameraId    Camera UUID
 * @returns LiveSession on success (always LOCAL)
 * @throws CameraOfflineError  when camera is offline / privacy mode on (503, 443-privacy)
 * @throws SessionLimitError   when Bosch quota hit (444)
 * @throws LiveSessionError    on 401, 404, 5xx, network, non-LOCAL response, or malformed response
 */
export declare function openLiveSession(httpClient: AxiosInstance, token: string, cameraId: string, highQualityVideo?: boolean): Promise<LiveSession>;
/**
 * Close an open live session (cleanup on adapter unload).
 *
 * Sends DELETE /v11/video_inputs/{cameraId}/connection.
 * HTTP 404 (already closed) is silently ignored.
 * Other non-2xx responses are logged but do not throw — best-effort cleanup.
 *
 * @param httpClient  Axios instance
 * @param token       Bearer access token
 * @param cameraId    Camera UUID
 */
export declare function closeLiveSession(httpClient: AxiosInstance, token: string, cameraId: string): Promise<void>;
//# sourceMappingURL=live_session.d.ts.map