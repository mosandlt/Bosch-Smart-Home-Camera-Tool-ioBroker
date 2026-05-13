/**
 * Bosch Cloud Live-Session opener.
 *
 * Opens a per-camera proxy session via:
 *   PUT https://residential.cbs.boschsecurity.com/v11/video_inputs/{id}/connection
 *
 * Response shapes (from HA __init__.py _try_live_connection_inner):
 *
 *   LOCAL (200/201):
 *     { "user": "cbs-XXXXXX", "password": "...", "urls": ["192.168.x.x:443"],
 *       "imageUrlScheme": "https://{url}/snap.jpg", "bufferingTime": 500, ... }
 *
 *   REMOTE (200/201):
 *     { "urls": ["proxy-NN:42090/{hash}"], "bufferingTime": 1000, ... }
 *     — or legacy shape: { "hash": "...", "proxyHost": "...", "proxyPort": 42090, ... }
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
import { type AxiosInstance } from "axios";
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
/** Result of a successful openLiveSession() call. */
export interface LiveSession {
    /** UUID of the camera (echoed back from the call arguments). */
    cameraId: string;
    /**
     * Full snapshot URL.
     * LOCAL:  https://<lan-ip>:443/snap.jpg?JpegSize=1206
     * REMOTE: https://proxy-NN.live.cbs.boschsecurity.com:42090/<hash>/snap.jpg?JpegSize=1206
     */
    proxyUrl: string;
    /** Connection type as established by Bosch. */
    connectionType: "LOCAL" | "REMOTE";
    /**
     * Digest username for LOCAL connections (e.g. "cbs-57355237").
     * Empty string for REMOTE connections (URL hash is the credential).
     */
    digestUser: string;
    /**
     * Digest password for LOCAL connections.
     * Empty string for REMOTE connections.
     */
    digestPassword: string;
    /**
     * LAN address returned by Bosch for LOCAL connections (e.g. "192.0.2.10:443").
     * Empty string for REMOTE connections.
     */
    lanAddress: string;
    /**
     * Session lifetime hint in milliseconds (from Bosch "bufferingTime" field).
     * Typical: 500 ms for LOCAL, 1000 ms for REMOTE.
     */
    bufferingTimeMs: number;
    /** When this session was opened (Date.now() epoch ms). */
    openedAt: number;
}
/**
 * Open a live proxy session for a camera.
 *
 * Calls PUT /v11/video_inputs/{cameraId}/connection with body:
 *   { "type": <mode>, "highQualityVideo": true }
 *
 * Returns a LiveSession containing the proxyUrl (for snap.jpg / RCP+)
 * and Digest credentials (LOCAL only).
 *
 * @param httpClient  Axios instance (caller controls SSL/timeout options)
 * @param token       Bearer access token
 * @param cameraId    Camera UUID
 * @param mode        Preferred connection type (default "AUTO")
 * @returns LiveSession on success
 * @throws CameraOfflineError  when camera is offline / privacy mode on (503, 443-privacy)
 * @throws SessionLimitError   when Bosch quota hit (444)
 * @throws LiveSessionError    on 401, 404, 5xx, network, or malformed response
 */
export declare function openLiveSession(httpClient: AxiosInstance, token: string, cameraId: string, mode?: "AUTO" | "LOCAL_ONLY" | "REMOTE_ONLY"): Promise<LiveSession>;
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