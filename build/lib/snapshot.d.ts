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
/**
 * Thrown when a snapshot fetch fails for any reason:
 *   - non-200 HTTP status
 *   - non-image Content-Type
 *   - empty response body
 *   - network / timeout error
 */
export declare class SnapshotError extends Error {
    readonly cause?: unknown;
    /**
     *
     * @param message
     * @param cause
     */
    constructor(message: string, cause?: unknown);
}
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
export declare function buildSnapshotUrl(proxyUrl: string, jpegSize?: number): string;
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
export declare function fetchSnapshot(proxyUrl: string, user: string, password: string, options?: {
    timeout?: number;
}): Promise<Buffer>;
//# sourceMappingURL=snapshot.d.ts.map