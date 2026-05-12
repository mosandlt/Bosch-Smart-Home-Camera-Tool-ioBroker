/**
 * Bosch Smart Home Camera — ioBroker Adapter
 *
 * Entry point. Authenticates against Bosch Keycloak (OAuth2 PKCE),
 * discovers cameras via the Bosch Residential Cloud API, and manages
 * ioBroker state objects for each camera entity.
 *
 * Implementation roadmap:
 *   1. [auth.ts]    OAuth2 PKCE login → access_token + refresh_token
 *   2. [cameras.ts] GET /v11/video_inputs → camera list
 *   3. [states]     Create ioBroker state tree per camera
 *   4. [stream.ts]  Register go2rtc RTSPS sources per camera (TODO)
 *   5. [fcm.ts]     FCM push registration → motion/audio/person events (TODO)
 *   6. [digest.ts]  HTTP Digest auth for local camera RCP+ commands (TODO)
 */
import * as utils from "@iobroker/adapter-core";
declare class BoschSmartHomeCamera extends utils.Adapter {
    /** setTimeout handle for the token refresh re-arm loop (ioBroker.Timeout | null). */
    private _refreshTimeout;
    /** Current refresh_token (kept in memory to avoid repeated state reads). */
    private _currentRefreshToken;
    /** Current access_token (kept in memory). */
    private _currentAccessToken;
    /** Cache: skip DB write when value is unchanged (iobroker.ring upsertState pattern). */
    private _stateCache;
    /** Axios instance shared across all HTTP calls. */
    private _httpClient;
    constructor(options?: Partial<utils.AdapterOptions>);
    /**
     * Write a state only if the value changed (iobroker.ring upsertState pattern).
     * Always creates the object if it doesn't exist yet, then sets ack=true.
     */
    private upsertState;
    /** Ensure the info channel + connection/token states exist. */
    private ensureInfoObjects;
    /**
     * Create the cameras device + one channel per camera.
     * Uses setObjectNotExistsAsync to preserve user history config.
     */
    private ensureCameraObjects;
    /** Save tokens to ioBroker states (survives adapter restart). */
    private saveTokens;
    /**
     * Load tokens from ioBroker states (from a previous run).
     * Returns null if tokens are absent or already expired.
     */
    private loadStoredTokens;
    /**
     * Schedule the next token refresh at 75% of remaining token lifetime.
     * Uses this.setTimeout (adapter-core) so ioBroker auto-cancels on unload.
     *
     * @param expiresInMs  Milliseconds until the current access_token expires.
     */
    private scheduleTokenRefresh;
    /**
     * Called once the adapter DB connection is ready.
     *
     * 1. Ensure info + token states exist
     * 2. Load stored tokens or perform fresh login
     * 3. Fetch camera list
     * 4. Create per-camera state tree
     * 5. Set info.connection = true
     * 6. Arm token refresh loop
     */
    private onReady;
    /**
     * Called whenever a subscribed state changes.
     * Only acts on ack=false states (user commands, not adapter-reported values).
     * Routes writes to the appropriate per-camera handler.
     */
    private onStateChange;
    /**
     * Privacy mode: RCP+ command 0x0808 via cloud proxy.
     * Full wiring deferred until live-session URL is available in state tree (v0.2.0).
     */
    private handlePrivacyToggle;
    /**
     * Camera light: RCP+ command 0x099f via cloud proxy.
     * Full wiring deferred to v0.2.0.
     */
    private handleLightToggle;
    /**
     * Image rotation: RCP+ command 0x0810 via cloud proxy.
     * Full wiring deferred to v0.2.0.
     */
    private handleImageRotationToggle;
    /**
     * Snapshot fetch: downloads JPEG via cloud snapshot URL and writes to adapter data folder.
     * Full wiring deferred to v0.2.0.
     */
    private handleSnapshotTrigger;
    /**
     * Called when the adapter is stopped.
     * Clears the refresh timer and sets info.connection = false.
     * Must always call callback() — ioBroker enforces a timeout.
     */
    private onUnload;
}
export { BoschSmartHomeCamera };
//# sourceMappingURL=main.d.ts.map