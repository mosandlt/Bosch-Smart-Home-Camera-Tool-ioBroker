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
import { type AxiosInstance } from "axios";
/** A Bosch SHC camera as returned by the cloud API. */
export interface BoschCamera {
    /** UUID, e.g. "EF791764-A48D-4F00-9B32-EF04BEB0DDA0" */
    id: string;
    /** User-given title, e.g. "Terrasse" */
    name: string;
    /** API hardwareVersion string, e.g. "HOME_Eyes_Outdoor" */
    hardwareVersion: string;
    /** Firmware string, e.g. "9.40.25" */
    firmwareVersion: string;
    /** Hardware generation, derived from hardwareVersion */
    generation: 1 | 2;
    /**
     * Online status.
     * Not available from the list endpoint — defaults to false.
     * Callers must check /commissioned or /ping per camera to populate.
     */
    online: boolean;
    /**
     * Current privacy mode as reported by the cloud list endpoint
     * ("ON" / "OFF" / undefined when the field is absent).
     *
     * The same `/v11/video_inputs` response that lists cameras also carries
     * the current `privacyMode` per camera — periodic refetch is the cheapest
     * way to sync app-side toggles back to ioBroker (forum #84538: user set
     * privacy via ioBroker, switched off via Bosch app, DP stayed ON).
     */
    privacyMode?: "ON" | "OFF";
    /**
     * Whether this camera reports `featureSupport.light === true`. Gen2 cams
     * (Eyes Indoor II + Outdoor II) with the multi-LED rig set this; old Gen1
     * with a single front LED don't. Gates the wallwasher RGB DPs so the
     * tree doesn't grow useless nodes on Gen1 cams.
     */
    featureLight?: boolean;
}
/**
 * The cameras API rejected the token (HTTP 401).
 * Caller should refresh the token and retry once.
 */
export declare class UnauthorizedError extends Error {
    /**
     *
     * @param message
     */
    constructor(message: string);
}
/**
 * The cameras API returned HTTP 5xx or a network error occurred.
 * Retry after backoff; do NOT invalidate the token.
 */
export declare class CamerasApiError extends Error {
    /**
     *
     * @param message
     */
    constructor(message: string);
}
/**
 * Determine camera generation (1 or 2) from the hardwareVersion string.
 *
 * Gen2 values: HOME_Eyes_Outdoor, HOME_Eyes_Indoor, CAMERA_OUTDOOR_GEN2, CAMERA_INDOOR_GEN2
 * Gen1 values: INDOOR, CAMERA_360, OUTDOOR, CAMERA_EYES, and all unknown strings
 *
 * Mirrors the MODELS registry in HA models.py.
 *
 * @param hardwareVersion
 */
export declare function detectGeneration(hardwareVersion: string): 1 | 2;
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
export declare function fetchCameras(httpClient: AxiosInstance, token: string): Promise<BoschCamera[]>;
//# sourceMappingURL=cameras.d.ts.map