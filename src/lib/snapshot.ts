/**
 * Snapshot fetcher for Bosch cameras via Cloud-Proxy + HTTP Digest auth.
 *
 * Cloud-Proxy URL format:
 *   LOCAL:  https://<lan-ip>:443/snap.jpg?JpegSize=1206
 *   REMOTE: https://proxy-XX.live.cbs.boschsecurity.com:PORT/HASH/snap.jpg?JpegSize=1206
 *
 * LOCAL connections require HTTP Digest auth (cbs-USERNAME credentials).
 * REMOTE connections use plain GET — the URL hash IS the credential.
 *
 * Reference: HA camera.py async_camera_image() lines ~615–680
 */

import axios from "axios";
import * as https from "https";
import { digestRequest } from "./digest";

// ── Error class ────────────────────────────────────────────────────────────────

/**
 * Thrown when a snapshot fetch fails for any reason:
 *   - non-200 HTTP status
 *   - non-image Content-Type
 *   - empty response body
 *   - network / timeout error
 */
export class SnapshotError extends Error {
    public readonly cause?: unknown;

    constructor(message: string, cause?: unknown) {
        super(message);
        this.name = "SnapshotError";
        this.cause = cause;
    }
}

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
export function buildSnapshotUrl(proxyUrl: string, jpegSize: number = 1206): string {
    // Strip trailing slash from the base URL
    const base = proxyUrl.replace(/\/+$/, "");

    let urlWithPath: string;
    if (base.endsWith("/snap.jpg")) {
        urlWithPath = base;
    } else {
        urlWithPath = `${base}/snap.jpg`;
    }

    // Append JpegSize — use ? or & depending on whether a query string exists
    const sep = urlWithPath.includes("?") ? "&" : "?";
    return `${urlWithPath}${sep}JpegSize=${jpegSize}`;
}

// ── Snapshot fetcher ───────────────────────────────────────────────────────────

/**
 * Fetch a single JPEG snapshot from a Bosch camera via the Cloud-Proxy URL.
 *
 * LOCAL connections use HTTP Digest auth (two-step: 401 challenge → authenticated GET).
 * REMOTE connections use plain GET — no credentials needed; the URL hash is the auth token.
 *
 * Mirrors HA camera.py async_camera_image() LOCAL+REMOTE branches.
 *
 * @param proxyUrl        Full snap.jpg URL (built by caller via buildSnapshotUrl)
 * @param connectionType  "LOCAL" → Digest auth; "REMOTE" → plain GET
 * @param user            Digest username (cbs-<USERNAME> for LOCAL; ignored for REMOTE)
 * @param password        Digest password (for LOCAL; ignored for REMOTE)
 * @param options.timeout Request timeout in ms (default 6000 — matches HA's 6 s cap)
 * @returns               JPEG image bytes as Buffer
 * @throws SnapshotError  On non-200 status / non-image content-type / empty body / network error
 */
export async function fetchSnapshot(
    proxyUrl: string,
    connectionType: "LOCAL" | "REMOTE",
    user: string,
    password: string,
    options: { timeout?: number } = {},
): Promise<Buffer> {
    const timeout = options.timeout ?? 6000;

    if (connectionType === "LOCAL") {
        // LOCAL: HTTP Digest auth (RFC 7616 — two-step 401 → authenticated GET)
        let resp: Awaited<ReturnType<typeof digestRequest>>;
        try {
            resp = await digestRequest(proxyUrl, user, password, {
                method: "GET",
                timeout,
                rejectUnauthorized: false,
            });
        } catch (err: unknown) {
            throw new SnapshotError(
                `LOCAL snapshot network error: ${(err as Error).message}`,
                err,
            );
        }

        if (resp.status !== 200) {
            throw new SnapshotError(
                `LOCAL snapshot returned HTTP ${resp.status} for ${proxyUrl}`,
            );
        }

        const ct = (resp.headers["content-type"] as string | undefined) ?? "";
        if (!ct.includes("image")) {
            throw new SnapshotError(
                `LOCAL snapshot returned non-image Content-Type: "${ct}"`,
            );
        }

        if (!resp.data || resp.data.length === 0) {
            throw new SnapshotError("LOCAL snapshot returned empty body");
        }

        return resp.data;
    }

    // REMOTE: plain GET — no credentials (URL hash is the auth token)
    const httpsAgent = new https.Agent({ rejectUnauthorized: false });
    let status: number;
    let contentType: string;
    let data: Buffer;

    try {
        const result = await axios.get<Buffer>(proxyUrl, {
            httpsAgent,
            timeout,
            responseType: "arraybuffer",
            validateStatus: () => true,
        });
        status = result.status;
        contentType = (result.headers["content-type"] as string | undefined) ?? "";
        data = Buffer.from(result.data);
    } catch (err: unknown) {
        throw new SnapshotError(
            `REMOTE snapshot network error: ${(err as Error).message}`,
            err,
        );
    }

    if (status !== 200) {
        throw new SnapshotError(
            `REMOTE snapshot returned HTTP ${status} for ${proxyUrl}`,
        );
    }

    if (!contentType.includes("image")) {
        throw new SnapshotError(
            `REMOTE snapshot returned non-image Content-Type: "${contentType}"`,
        );
    }

    if (!data || data.length === 0) {
        throw new SnapshotError("REMOTE snapshot returned empty body");
    }

    return data;
}
