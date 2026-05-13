"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.SessionLimitError = exports.CameraOfflineError = exports.LiveSessionError = void 0;
exports.openLiveSession = openLiveSession;
exports.closeLiveSession = closeLiveSession;
const auth_1 = require("./auth");
// ── Error classes ──────────────────────────────────────────────────────────────
/**
 * Thrown on 5xx / network / malformed-response errors from the connection
 * endpoint. The session was not established.
 */
class LiveSessionError extends Error {
    cause;
    constructor(message, cause) {
        super(message);
        this.name = "LiveSessionError";
        this.cause = cause;
    }
}
exports.LiveSessionError = LiveSessionError;
/**
 * Thrown when the camera is offline or privacy mode is on (Bosch returns
 * HTTP 503 or 444 with the body "sh:camera.in.privacy.mode" for privacy,
 * and HTTP 503 for genuine offline). Callers should stop retrying until
 * the camera comes back online.
 */
class CameraOfflineError extends Error {
    constructor(message) {
        super(message);
        this.name = "CameraOfflineError";
    }
}
exports.CameraOfflineError = CameraOfflineError;
/**
 * Thrown when Bosch returns HTTP 444 (session quota hit).
 * The caller should back off and retry after closing unused sessions.
 */
class SessionLimitError extends Error {
    constructor(message) {
        super(message);
        this.name = "SessionLimitError";
    }
}
exports.SessionLimitError = SessionLimitError;
// ── Internal helpers ───────────────────────────────────────────────────────────
const SNAP_SUFFIX = "/snap.jpg?JpegSize=1206";
/**
 * Build the snap.jpg proxy URL from a raw Bosch "urls" entry and the
 * imageUrlScheme (LOCAL) or fixed HTTPS format (REMOTE).
 *
 * LOCAL:  imageUrlScheme = "https://{url}/snap.jpg"; substitute {url} = "192.168.x.x:443"
 * REMOTE: urls[0] = "proxy-NN:42090/{hash}" → prepend "https://"
 */
function buildProxyUrl(connectionType, urlEntry, imageUrlScheme) {
    if (connectionType === "LOCAL") {
        // Replace {url} placeholder in imageUrlScheme if available, else default
        const scheme = imageUrlScheme ?? "https://{url}/snap.jpg";
        let url = scheme.replace("{url}", urlEntry);
        // Ensure JpegSize is set
        if (!url.includes("JpegSize=")) {
            url += (url.includes("?") ? "&" : "?") + "JpegSize=1206";
        }
        return url;
    }
    // REMOTE: urlEntry is "proxy-NN:42090/{hash}"
    return `https://${urlEntry}${SNAP_SUFFIX}`;
}
// ── openLiveSession ────────────────────────────────────────────────────────────
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
async function openLiveSession(httpClient, token, cameraId, mode = "AUTO") {
    // Map adapter mode to Bosch API type string
    // AUTO → try LOCAL first (mirrors HA AUTO behaviour on LAN); we pass "LOCAL"
    // and let callers fall back to REMOTE_ONLY on failure if needed.
    // For simplicity in the ioBroker adapter, mode collapses to a single PUT.
    const typeVal = mode === "LOCAL_ONLY" ? "LOCAL" :
        mode === "REMOTE_ONLY" ? "REMOTE" :
            /* AUTO */ "LOCAL";
    const url = `${auth_1.CLOUD_API}/v11/video_inputs/${cameraId}/connection`;
    const headers = {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
    };
    const body = { type: typeVal, highQualityVideo: true };
    let status;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let data;
    try {
        const resp = await httpClient.put(url, body, {
            headers,
            validateStatus: () => true, // handle all status codes ourselves
        });
        status = resp.status;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        data = (resp.data ?? {});
    }
    catch (err) {
        throw new LiveSessionError(`PUT /connection network error for ${cameraId}: ${err.message}`, err);
    }
    // ── Error handling (mirrors HA _try_live_connection_inner) ─────────────────
    if (status === 444) {
        throw new SessionLimitError(`Bosch session quota hit (444) for camera ${cameraId}`);
    }
    if (status === 503) {
        throw new CameraOfflineError(`Camera ${cameraId} offline or unreachable (HTTP 503)`);
    }
    if (status === 401) {
        throw new LiveSessionError(`Bearer token expired or invalid (401) for camera ${cameraId}`);
    }
    if (status === 404) {
        throw new LiveSessionError(`Camera ${cameraId} not found (404)`);
    }
    if (status !== 200 && status !== 201) {
        throw new LiveSessionError(`PUT /connection returned HTTP ${status} for camera ${cameraId}`);
    }
    // ── Parse LOCAL response ────────────────────────────────────────────────────
    const localUser = typeof data["user"] === "string" ? data["user"] : "";
    const localPass = typeof data["password"] === "string" ? data["password"] : "";
    const urls = Array.isArray(data["urls"]) ? data["urls"] : [];
    const bufferingTimeMs = typeof data["bufferingTime"] === "number" ? data["bufferingTime"] : 1000;
    if (typeVal === "LOCAL" && localUser && localPass && urls.length > 0) {
        const lanAddr = urls[0];
        const imageUrlScheme = typeof data["imageUrlScheme"] === "string"
            ? data["imageUrlScheme"]
            : undefined;
        const proxyUrl = buildProxyUrl("LOCAL", lanAddr, imageUrlScheme);
        return {
            cameraId,
            proxyUrl,
            connectionType: "LOCAL",
            digestUser: localUser,
            digestPassword: localPass,
            lanAddress: lanAddr,
            bufferingTimeMs,
            openedAt: Date.now(),
        };
    }
    // ── Parse REMOTE response ───────────────────────────────────────────────────
    if (urls.length > 0) {
        const proxyUrl = buildProxyUrl("REMOTE", urls[0]);
        return {
            cameraId,
            proxyUrl,
            connectionType: "REMOTE",
            digestUser: "",
            digestPassword: "",
            lanAddress: "",
            bufferingTimeMs,
            openedAt: Date.now(),
        };
    }
    // Legacy REMOTE shape: { hash, proxyHost, proxyPort }
    const hash = typeof data["hash"] === "string" ? data["hash"] : "";
    if (hash) {
        const proxyHost = typeof data["proxyHost"] === "string"
            ? data["proxyHost"]
            : "proxy-01.live.cbs.boschsecurity.com";
        const proxyPort = typeof data["proxyPort"] === "number" ? data["proxyPort"] : 42090;
        const proxyUrl = `https://${proxyHost}:${proxyPort}/${hash}${SNAP_SUFFIX}`;
        return {
            cameraId,
            proxyUrl,
            connectionType: "REMOTE",
            digestUser: "",
            digestPassword: "",
            lanAddress: "",
            bufferingTimeMs,
            openedAt: Date.now(),
        };
    }
    // Response 2xx but no usable URL extracted
    throw new LiveSessionError(`PUT /connection returned HTTP ${status} but response missing proxyUrl/urls for camera ${cameraId}`);
}
// ── closeLiveSession ───────────────────────────────────────────────────────────
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
async function closeLiveSession(httpClient, token, cameraId) {
    const url = `${auth_1.CLOUD_API}/v11/video_inputs/${cameraId}/connection`;
    const headers = {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
    };
    try {
        await httpClient.delete(url, {
            headers,
            validateStatus: () => true,
        });
        // All status codes accepted — 404 = already closed (ok), others = best-effort
    }
    catch {
        // Network error on cleanup — swallow silently
    }
}
//# sourceMappingURL=live_session.js.map