"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SnapshotError = void 0;
exports.buildSnapshotUrl = buildSnapshotUrl;
exports.fetchSnapshot = fetchSnapshot;
const axios_1 = __importDefault(require("axios"));
const https = __importStar(require("node:https"));
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
 * @param options
 * @param options.timeout Request timeout in ms (default 6000 — matches HA's 6 s cap)
 * @returns               JPEG image bytes as Buffer
 * @throws SnapshotError  On non-200 status / non-image content-type / empty body / network error
 */
async function fetchSnapshot(proxyUrl, connectionType, user, password, options = {}) {
    const timeout = options.timeout ?? 6000;
    if (connectionType === "LOCAL") {
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
    // REMOTE: plain GET — no credentials (URL hash is the auth token)
    const httpsAgent = new https.Agent({ rejectUnauthorized: false });
    let status;
    let contentType;
    let data;
    try {
        const result = await axios_1.default.get(proxyUrl, {
            httpsAgent,
            timeout,
            responseType: "arraybuffer",
            validateStatus: () => true,
        });
        status = result.status;
        contentType = result.headers["content-type"] ?? "";
        data = Buffer.from(result.data);
    }
    catch (err) {
        throw new SnapshotError(`REMOTE snapshot network error: ${err.message}`, err);
    }
    if (status !== 200) {
        throw new SnapshotError(`REMOTE snapshot returned HTTP ${status} for ${proxyUrl}`);
    }
    if (!contentType.includes("image")) {
        throw new SnapshotError(`REMOTE snapshot returned non-image Content-Type: "${contentType}"`);
    }
    if (!data || data.length === 0) {
        throw new SnapshotError("REMOTE snapshot returned empty body");
    }
    return data;
}
//# sourceMappingURL=snapshot.js.map