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
 *   7. [rcp.ts]          RCP+ protocol helpers (unused since v0.3.0 — all commands use Cloud API)
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
    /**
     * Client-side image rotation flag per camera ID.
     * Bosch Cloud API has no rotation endpoint — flag is stored here so
     * downstream callers (snapshot post-processing, UI) can apply 180° transforms.
     */
    private _imageRotation;
    /**
     * ISO timestamp of the latest processed event per camera.
     * Used by fetchAndProcessEvents() to skip events we've already seen.
     * Keyed by camera ID. float('-inf') equivalent → empty string means "not seen".
     */
    private _lastSeenEventId;
    /**
     * Count of consecutive snapshot failures per camera ID.
     * Used to flip `online=false` only after a sustained outage, not on the first
     * transient network blip. Reset on every successful snapshot.
     */
    private _snapshotFailCount;
    /** Consecutive snapshot failures before a camera is marked offline. */
    private static readonly OFFLINE_THRESHOLD;
    constructor(options?: Partial<utils.AdapterOptions>);
    /**
     * Write a state only if the value changed (iobroker.ring upsertState pattern).
     * Always creates the object if it doesn't exist yet, then sets ack=true.
     *
     * @param id
     * @param value
     */
    private upsertState;
    /** Ensure the info channel + connection/token states exist. */
    private ensureInfoObjects;
    /**
     * Create the cameras device + one channel per camera.
     * Uses setObjectNotExistsAsync to preserve user history config.
     *
     * @param cameras
     */
    private ensureCameraObjects;
    /**
     * Save tokens to ioBroker states (survives adapter restart).
     *
     * @param tokens
     */
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
     *
     * @param camId
     */
    private ensureLiveSession;
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
     * 7. Start FCM listener (real push via @aracna/fcm, sets info.fcm_active = "healthy")
     */
    private onReady;
    /**
     * Called whenever a subscribed state changes.
     * Only acts on ack=false states (user commands, not adapter-reported values).
     * Routes writes to the appropriate per-camera handler.
     *
     * @param id
     * @param state
     */
    private onStateChange;
    /**
     * Handle an FCM motion/person/audio_alarm push event.
     * Writes per-camera last_motion_at + last_motion_event_type states.
     *
     * @param ev
     */
    private onFcmEvent;
    /**
     * Fetch fresh events for all known cameras from the Bosch Cloud API.
     *
     * Called on every FCM "push" (silent wake-up — Bosch sends no event payload
     * in the push itself). Mirrors Python async_handle_fcm_push() in fcm.py.
     *
     * Endpoint: GET /v11/events?videoInputId={camId}&limit=5
     * Returns: array of event objects (newest first) or empty array.
     *
     * Event object fields (confirmed via HA integration):
     *   { id, eventType, eventTags, timestamp/createdAt, videoInputId }
     * Gen2: eventType=MOVEMENT + eventTags=["PERSON"] → normalise to "person"
     */
    private fetchAndProcessEvents;
    /**
     * Privacy mode: PUT /v11/video_inputs/{camId}/privacy with
     * { privacyMode: "ON" | "OFF", durationInSeconds: null }.
     *
     * Matches HA's `async_cloud_set_privacy_mode()` in shc.py. Cloud-API path
     * is the primary (fast ~150ms) and works for both Gen1 + Gen2. RCP+ LOCAL
     * is NOT used here because Bosch's Gen2 firmware rejects WRITE 0x0808 over
     * Digest auth (verified live: HTTP 401 even with correct credentials).
     *
     * @param camId
     * @param enabled
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
     *
     * @param camId
     * @param enabled
     */
    private handleLightToggle;
    /**
     * Image rotation: pure client-side flag — no Bosch Cloud API endpoint exists.
     *
     * Bosch's Cloud API has no image-rotation field (confirmed in the HA integration:
     * "Cloud API does not expose any image-rotation field; this switch is a pure
     * client-side display flag"). RCP+ 0x0810 returned HTTP 401 on Gen2 FW 9.40.25
     * with valid Digest auth — and even if it worked, it would only affect the
     * camera's own RTSP stream orientation, not how ioBroker consumers display it.
     *
     * The flag is stored in-memory (_imageRotation) so downstream callers (snapshot
     * post-processing, UI consumers reading the state) can apply 180° transforms.
     *
     * @param camId
     * @param rotated180
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
     *
     * @param camId
     */
    private handleSnapshotTrigger;
    /**
     * Update `cameras.<id>.online` based on snapshot reachability.
     *
     * Bosch's list endpoint does not expose connectivity, so the only signal we have
     * is whether snapshot fetches succeed. We mark a camera offline only after
     * {@link BoschSmartHomeCamera.OFFLINE_THRESHOLD} consecutive failures —
     * a single transient "stream has been aborted" must not flip the state.
     *
     * @param camId
     * @param reachable
     */
    private markCameraReachability;
    /**
     * Called when the adapter is stopped.
     * Cleans up TLS proxies, FCM listener, live sessions, and the refresh timer.
     * Must always call callback() — ioBroker enforces a timeout.
     *
     * @param callback
     */
    private onUnload;
}
export { BoschSmartHomeCamera };
//# sourceMappingURL=main.d.ts.map