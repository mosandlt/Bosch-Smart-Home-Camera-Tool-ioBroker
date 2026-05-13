/**
 * Bosch Smart Home Camera — ioBroker Adapter
 *
 * Entry point. Authenticates against Bosch Keycloak (OAuth2 PKCE),
 * discovers cameras via the Bosch Residential Cloud API, and manages
 * ioBroker state objects for each camera entity.
 *
 * Implementation roadmap:
 *   1. [auth.ts]         OAuth2 PKCE login → access_token + refresh_token
 *   2. [cameras.ts]      GET /v11/video_inputs → camera list
 *   3. [states]          Create ioBroker state tree per camera
 *   4. [live_session.ts] Open proxy session per camera (v0.2.0)
 *   5. [tls_proxy.ts]    Register RTSPS sources as local RTSP via TLS proxy (v0.2.0)
 *   6. [fcm.ts]          FCM push registration → motion/audio/person events (stub → v0.3.0)
 *   7. [rcp.ts]          RCP+ commands: privacy, light, image rotation (v0.2.0)
 *   8. [snapshot.ts]     Snapshot fetch + write to adapter file-store (v0.2.0)
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
    /** Live sessions keyed by camera ID. Re-opened when stale. */
    private _liveSessions;
    /** TLS proxy handles keyed by camera ID. */
    private _tlsProxies;
    /** Camera metadata keyed by camera ID (populated in onReady from fetchCameras). */
    private _cameras;
    /** FCM push listener (null until onReady wires it up). */
    private _fcmListener;
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
     * Ensure a fresh live session exists for the given camera ID.
     *
     * Caches sessions and reuses them while they are within 75% of their
     * bufferingTime. Opens a new session (and spawns a TLS proxy) when stale.
     *
     * Note: bufferingTimeMs from Bosch is typically 500 ms (LOCAL) or 1000 ms
     * (REMOTE). We treat it as minimum keepalive time and open a fresh session
     * on every command if the cached one is more than 30 seconds old — a
     * conservative threshold that avoids session-expired errors in practice.
     */
    private ensureLiveSession;
    /**
     * Derive the rcp.xml base URL from a live session.
     *
     * LOCAL:  "https://192.168.x.x:443/rcp.xml"
     * REMOTE: "https://proxy-NN:42090/{hash}/rcp.xml"
     */
    private getRcpUrl;
    /**
     * Generate (or reuse) a PKCE pair, build the Bosch auth URL, and log it.
     *
     * The verifier is stored in info.pkce_verifier so it survives restarts —
     * regenerated only after a successful code exchange or explicit reset.
     * This prevents "stale verifier" errors when the user copies the URL from
     * one adapter start and pastes after a second restart.
     */
    private showLoginUrl;
    /**
     * Exchange a pasted OIDC redirect URL for access + refresh tokens.
     *
     * Reads the stored PKCE verifier, extracts the auth code from the URL,
     * calls Keycloak token endpoint, saves tokens, and clears the paste field.
     *
     * @param url  Full redirect URL pasted by the user
     * @returns TokenResult on success
     * @throws Error if code extraction or token exchange fails
     */
    private handleRedirectPaste;
    /**
     * Called once the adapter DB connection is ready.
     *
     * 1. Ensure info + token states exist
     * 2. Load stored tokens or perform fresh login
     * 3. Fetch camera list
     * 4. Create per-camera state tree
     * 5. Set info.connection = true
     * 6. Arm token refresh loop
     * 7. Start FCM listener (stub → sets info.fcm_active = "stub")
     */
    private onReady;
    /**
     * Called whenever a subscribed state changes.
     * Only acts on ack=false states (user commands, not adapter-reported values).
     * Routes writes to the appropriate per-camera handler.
     */
    private onStateChange;
    /**
     * Handle an FCM motion/person/audio_alarm push event.
     * Writes per-camera last_motion_at + last_motion_event_type states.
     */
    private onFcmEvent;
    /**
     * Derive Digest credentials from a live session for LOCAL RCP+ calls.
     * Cloud proxy URLs are pre-authenticated via the URL hash — return undefined
     * so the REMOTE codepath is taken in sendRcpCommand().
     */
    private getRcpAuth;
    /**
     * Privacy mode: PUT /v11/video_inputs/{camId}/privacy with
     * { privacyMode: "ON" | "OFF", durationInSeconds: null }.
     *
     * Matches HA's `async_cloud_set_privacy_mode()` in shc.py. Cloud-API path
     * is the primary (fast ~150ms) and works for both Gen1 + Gen2. RCP+ LOCAL
     * is NOT used here because Bosch's Gen2 firmware rejects WRITE 0x0808 over
     * Digest auth (verified live: HTTP 401 even with correct credentials).
     */
    private handlePrivacyToggle;
    /**
     * Camera light: Cloud-API PUT, Gen-specific endpoint.
     *
     * Gen2: PUT /v11/video_inputs/{id}/lighting/switch/front + /topdown
     *       with body { enabled: true|false }
     * Gen1: PUT /v11/video_inputs/{id}/lighting_override
     *       with body { frontLightOn, wallwasherOn, frontLightIntensity? }
     *
     * Matches HA's `async_cloud_set_camera_light()` in shc.py.
     */
    private handleLightToggle;
    /**
     * Image rotation: RCP+ command 0x0810 WRITE (Digest for LOCAL, hash for REMOTE).
     */
    private handleImageRotationToggle;
    /**
     * Snapshot fetch: opens a live session, downloads JPEG via snap.jpg URL,
     * writes to the adapter file-store, and updates cameras.<id>.snapshot_path.
     *
     * Bosch cameras frequently abort the first snap.jpg request after a long
     * idle period with "stream has been aborted" — observed live on Gen2
     * Outdoor (Terrasse, FW 9.40.25). The second attempt (within ~5s) always
     * succeeds. We retry once with a short backoff before giving up; mirrors
     * HA integration's snap.jpg retry pattern.
     */
    private handleSnapshotTrigger;
    /**
     * Called when the adapter is stopped.
     * Cleans up TLS proxies, FCM listener, live sessions, and the refresh timer.
     * Must always call callback() — ioBroker enforces a timeout.
     */
    private onUnload;
}
export { BoschSmartHomeCamera };
//# sourceMappingURL=main.d.ts.map