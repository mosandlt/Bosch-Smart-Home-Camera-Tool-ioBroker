"use strict";
/**
 * Bosch Camera Discovery
 *
 * Fetches the list of cameras from the Bosch Cloud API.
 *
 * Endpoint: GET https://residential.cbs.boschsecurity.com/v11/video_inputs
 * Auth:     Authorization: Bearer <access_token>
 *
 * Response shape (array of video input objects):
 *   id              — UUID, e.g. "EF791764-A48D-4F00-9B32-EF04BEB0DDA0"
 *   title           — user-given camera name, e.g. "Terrasse"
 *   hardwareVersion — model string, e.g. "HOME_Eyes_Outdoor", "CAMERA_360"
 *   firmwareVersion — firmware string, e.g. "9.40.25"
 *
 * Online status is NOT available from the list endpoint — it requires a
 * separate /commissioned or /ping call per camera. The online field defaults
 * to false (unknown) until callers check status separately.
 *
 * Generation detection (mirrored from HA models.py MODELS registry):
 *   Gen2: HOME_Eyes_Outdoor, HOME_Eyes_Indoor, CAMERA_OUTDOOR_GEN2, CAMERA_INDOOR_GEN2
 *   Gen1: INDOOR, CAMERA_360, OUTDOOR, CAMERA_EYES (and all unknown models)
 *
 * Port of Python bosch_camera.py discover_cameras() and
 * HA __init__.py _async_update_data() camera-list logic.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CamerasApiError = exports.UnauthorizedError = void 0;
exports.detectGeneration = detectGeneration;
exports.fetchCameras = fetchCameras;
const axios_1 = __importDefault(require("axios"));
const auth_1 = require("./auth");
// ── Error classes ─────────────────────────────────────────────────────────────
/**
 * The cameras API rejected the token (HTTP 401).
 * Caller should refresh the token and retry once.
 */
class UnauthorizedError extends Error {
    constructor(message) {
        super(message);
        this.name = "UnauthorizedError";
    }
}
exports.UnauthorizedError = UnauthorizedError;
/**
 * The cameras API returned HTTP 5xx or a network error occurred.
 * Retry after backoff; do NOT invalidate the token.
 */
class CamerasApiError extends Error {
    constructor(message) {
        super(message);
        this.name = "CamerasApiError";
    }
}
exports.CamerasApiError = CamerasApiError;
// ── Generation detection ──────────────────────────────────────────────────────
/**
 * Known Gen2 hardwareVersion strings (from HA models.py + Python CLI).
 * All other values (INDOOR, OUTDOOR, CAMERA_360, CAMERA_EYES, unknown) → Gen1.
 */
const GEN2_HARDWARE_VERSIONS = new Set([
    "HOME_Eyes_Outdoor",
    "HOME_Eyes_Indoor",
    "CAMERA_OUTDOOR_GEN2",
    "CAMERA_INDOOR_GEN2",
]);
/**
 * Determine camera generation (1 or 2) from the hardwareVersion string.
 *
 * Gen2 values: HOME_Eyes_Outdoor, HOME_Eyes_Indoor, CAMERA_OUTDOOR_GEN2, CAMERA_INDOOR_GEN2
 * Gen1 values: INDOOR, CAMERA_360, OUTDOOR, CAMERA_EYES, and all unknown strings
 *
 * Mirrors the MODELS registry in HA models.py.
 */
function detectGeneration(hardwareVersion) {
    return GEN2_HARDWARE_VERSIONS.has(hardwareVersion) ? 2 : 1;
}
// ── Camera fetch ──────────────────────────────────────────────────────────────
/**
 * Map a raw API camera object to a typed BoschCamera.
 * Returns null if the required `id` field is missing or empty.
 * Missing name/hardwareVersion/firmwareVersion fields get safe defaults.
 */
function mapCamera(raw) {
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    if (!id) {
        return null;
    }
    const name = typeof raw.title === "string" && raw.title ? raw.title : id;
    const hw = typeof raw.hardwareVersion === "string" ? raw.hardwareVersion : "";
    const fw = typeof raw.firmwareVersion === "string" ? raw.firmwareVersion : "";
    return {
        id,
        name,
        hardwareVersion: hw,
        firmwareVersion: fw,
        generation: detectGeneration(hw),
        online: false, // list endpoint does not include connection state
    };
}
/**
 * Fetch the list of cameras for the authenticated account.
 *
 * Calls GET https://residential.cbs.boschsecurity.com/v11/video_inputs
 * with the provided Bearer token.
 *
 * @param httpClient  Axios instance (allows injection for testing)
 * @param token       Current access_token (Bearer)
 * @returns           Camera list (empty array if the account has no cameras)
 * @throws UnauthorizedError  on HTTP 401 (caller should refresh token + retry)
 * @throws CamerasApiError    on HTTP 5xx or network/timeout error
 */
async function fetchCameras(httpClient, token) {
    try {
        const resp = await httpClient.get(`${auth_1.CLOUD_API}/v11/video_inputs`, {
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: "application/json",
            },
        });
        const data = resp.data;
        if (!Array.isArray(data)) {
            // Unexpected response shape — treat as empty (defensive)
            return [];
        }
        const cameras = [];
        for (const raw of data) {
            const cam = mapCamera(raw);
            if (cam !== null) {
                cameras.push(cam);
            }
        }
        return cameras;
    }
    catch (err) {
        if (axios_1.default.isAxiosError(err)) {
            const status = err.response?.status;
            if (status === 401) {
                throw new UnauthorizedError(`Cameras API HTTP 401: ${JSON.stringify(err.response?.data ?? "")}`);
            }
            if (status !== undefined && status >= 500) {
                throw new CamerasApiError(`Cameras API HTTP ${status}`);
            }
            // Network/timeout (no response) → CamerasApiError
            throw new CamerasApiError(`Cameras API network error: ${err.message}`);
        }
        throw err;
    }
}
//# sourceMappingURL=cameras.js.map