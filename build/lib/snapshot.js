"use strict";
/**
 * Snapshot fetcher for Bosch cameras via LOCAL HTTP Digest auth.
 *
 * LOCAL URL format:
 *   https://<lan-ip>:443/snap.jpg?JpegSize=1206
 *
 * LOCAL connections require HTTP Digest auth (cbs-USERNAME credentials).
 * Cloud-relay paths (proxy-NN.live.cbs.boschsecurity.com) are NEVER used
 * for media — this adapter is LOCAL-only by design (v0.4.0).
 *
 * Reference: HA camera.py async_camera_image() lines ~615–680
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SnapshotError = void 0;
exports.buildSnapshotUrl = buildSnapshotUrl;
exports.fetchSnapshot = fetchSnapshot;
const digest_1 = require("./digest");
// ── Error class ────────────────────────────────────────────────────────────────
/**
 * Thrown when a snapshot fetch fails for any reason:
 *   - non-200 HTTP status
 *   - non-image Content-Type
 *   - empty response body
 *   - network / timeout error
 */
class SnapshotError extends Error {
    cause;
    /**
     *
     * @param message
     * @param cause
     */
    constructor(message, cause) {
        super(message);
        this.name = "SnapshotError";
        this.cause = cause;
    }
}
exports.SnapshotError = SnapshotError;
// ── URL builder ────────────────────────────────────────────────────────────────
/**
 * Build the snap.jpg URL for a given proxy base URL.
 *
 * Handles three input forms:
 *   1. Base URL (no path)           → appends /snap.jpg?JpegSize=N
 *   2. URL already ending /snap.jpg → appends ?JpegSize=N
 *   3. URL with existing query      → appends &JpegSize=N (preserves existing params)
 *
 * Valid Bosch JpegSize values: 320, 640, 1206 (full-res default).
 *
 * @param proxyUrl  Base proxy URL or snap.jpg URL (from live-session metadata)
 * @param jpegSize  JPEG resolution hint (default 1206 = full-res)
 * @returns Full snap.jpg URL with JpegSize query parameter
 */
function buildSnapshotUrl(proxyUrl, jpegSize = 1206) {
    // Strip trailing slash from the base URL
    const base = proxyUrl.replace(/\/+$/, "");
    let urlWithPath;
    if (base.endsWith("/snap.jpg")) {
        urlWithPath = base;
    }
    else {
        urlWithPath = `${base}/snap.jpg`;
    }
    // Append JpegSize — use ? or & depending on whether a query string exists
    const sep = urlWithPath.includes("?") ? "&" : "?";
    return `${urlWithPath}${sep}JpegSize=${jpegSize}`;
}
// ── Snapshot fetcher ───────────────────────────────────────────────────────────
/**
 * Fetch a single JPEG snapshot from a Bosch camera via LOCAL HTTP Digest auth.
 *
 * Uses two-step Digest auth (RFC 7616: 401 challenge → authenticated GET).
 * Mirrors HA camera.py async_camera_image() LOCAL branch.
 *
 * Cloud-relay paths are NEVER used — this adapter is LOCAL-only by design.
 *
 * @param proxyUrl   Full snap.jpg URL (built by caller via buildSnapshotUrl)
 * @param user       Digest username (cbs-<USERNAME>)
 * @param password   Digest password
 * @param options
 * @param options.timeout  Request timeout in ms (default 6000 — matches HA's 6 s cap)
 * @returns          JPEG image bytes as Buffer
 * @throws SnapshotError  On non-200 status / non-image content-type / empty body / network error
 */
async function fetchSnapshot(proxyUrl, user, password, options = {}) {
    const timeout = options.timeout ?? 6000;
    // LOCAL: HTTP Digest auth (RFC 7616 — two-step 401 → authenticated GET)
    let resp;
    try {
        resp = await (0, digest_1.digestRequest)(proxyUrl, user, password, {
            method: "GET",
            timeout,
            rejectUnauthorized: false,
        });
    }
    catch (err) {
        throw new SnapshotError(`LOCAL snapshot network error: ${err.message}`, err);
    }
    if (resp.status !== 200) {
        throw new SnapshotError(`LOCAL snapshot returned HTTP ${resp.status} for ${proxyUrl}`);
    }
    const ct = resp.headers["content-type"] ?? "";
    if (!ct.includes("image")) {
        throw new SnapshotError(`LOCAL snapshot returned non-image Content-Type: "${ct}"`);
    }
    if (!resp.data || resp.data.length === 0) {
        throw new SnapshotError("LOCAL snapshot returned empty body");
    }
    return resp.data;
}
//# sourceMappingURL=snapshot.js.map