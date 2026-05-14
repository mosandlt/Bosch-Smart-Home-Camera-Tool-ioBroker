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
/**
 *
 */
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
    /** RTSP session watchdogs keyed by camera ID. Renew LOCAL sessions before expiry. */
    private _sessionWatchdogs;
    /**
     * Client-side image rotation flag per camera ID.
     * Bosch Cloud API has no rotation endpoint — flag is stored here so
     * downstream callers (snapshot post-processing, UI) can apply 180° transforms.
     */
    private _imageRotation;
    /**
     * Stream-quality preference per camera ID. v0.5.0 — controls the
     * `highQualityVideo` flag in PUT /v11/video_inputs/{id}/connection.
     * Default "high" (full bitrate). Changing this state forces the next
     * ensureLiveSession() to re-open with the new flag.
     */
    private _streamQuality;
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
    /**
     * Polling timer for /v11/events when FCM push registration failed.
     * Drives event ingestion without push so motion/audio events still surface.
     * Null when FCM is healthy (push is the primary path).
     */
    private _eventPollTimer;
    /** Event-poll interval (ms) when FCM push is unavailable. */
    private static readonly EVENT_POLL_INTERVAL_MS;
    /**
     * Periodic poll of /v11/video_inputs to pick up app-side state changes
     * (privacy toggled via the Bosch app, camera renamed, …). Independent of
     * FCM — runs always so DPs stay accurate even with push healthy.
     * Forum #84538: user set privacy_enabled via ioBroker, toggled it off
     * via the app, ioBroker DP stayed `true` because we only fetched once.
     */
    private _statePollTimer;
    /** Camera-state poll interval (ms). */
    private static readonly STATE_POLL_INTERVAL_MS;
    /**
     * Sticky TLS-proxy port per camera ID. Set on first proxy start
     * (ephemeral free port from the OS), then reused across session renewals
     * and adapter restarts so external recorders (BlueIris) keep working
     * without re-configuring the URL on every hourly session renewal.
     */
    private _stickyProxyPort;
    /**
     * Remembered upstream LAN address (`<ip>:<port>`) per camera. Used by
     * `upsertSession()` to decide whether a renewed Bosch session points at
     * the same camera (→ keep the proxy + port intact) or at a different
     * address (→ tear down + restart).
     */
    private _sessionRemote;
    /**
     * Desired siren (panic_alarm) state per Gen2 camera. The Bosch cloud has
     * no GET for this state — the iOS/Android apps keep their own copy and
     * we do the same. Wiped on adapter restart (camera also auto-stops the
     * siren after a hardware-defined timeout, so a stale `true` is fine to
     * forget).
     */
    private _sirenState;
    /**
     * Cached lighting state per Gen2 camera (frontLight + topLed + bottomLed
     * brightness/color/whiteBalance). Seeded by the state-poll GET on the
     * `/lighting/switch` endpoint and updated from every PUT response. Used
     * to merge incremental DP writes into the full body Bosch requires.
     */
    private _lightingCache;
    /**
     * Whether a continuous live RTSP stream is active per camera ID.
     * Default: false (no livestream on adapter start — Bosch counts every
     * open session against the daily LOCAL session limit, so we don't want
     * to burn quota on cameras the user isn't actively watching). When
     * `cameras.<id>.livestream_enabled` is true, ensureLiveSession() keeps
     * the Bosch session + TLS proxy + watchdog alive; when false, the
     * adapter still opens short-lived sessions for snapshots but tears them
     * down immediately after so no proxy/watchdog stays running.
     */
    private _livestreamEnabled;
    /**
     *
     * @param options
     */
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
     * Ensure a fresh live session exists for the given camera ID (LOCAL only).
     *
     * Caches sessions and reuses them while they are within 30 s of being opened.
     * On a fresh session, spawns a TLS proxy and arms the RTSP session watchdog
     * so the stream renews automatically before the Bosch LOCAL session expires.
     *
     * This adapter is LOCAL-only by design: cloud-relay paths are never used
     * for media. If the camera is unreachable on the LAN, the call throws.
     *
     * @param camId
     */
    private ensureLiveSession;
    /**
     * Spawn (or replace) the TLS proxy for the given session and update stream_url.
     * Extracted so both ensureLiveSession and the watchdog onRenew callback can reuse it.
     *
     * Two forum-driven behaviours (issue #84538):
     *   - **Sticky port**: on first run the OS picks a free ephemeral port; we
     *     persist it (`_stickyProxyPort` + state `cameras.<id>._proxy_port`)
     *     and reuse it on every renewal / adapter restart so an external
     *     recorder (BlueIris) keeps the same URL. Falls back to a new
     *     ephemeral port if the old one is taken (e.g. another process).
     *   - **Credentials in URL**: Bosch's RTSP endpoint demands Digest auth;
     *     embed `user:password@host:port` so the recorder can authenticate
     *     without a separate config step.
     *
     * @param camId    Camera UUID
     * @param session  Freshly opened LiveSession (always LOCAL)
     */
    private upsertSession;
    /**
     * Resolve the RTSP proxy bind host + URL host from adapter config.
     * Default: bind 127.0.0.1, URL uses 127.0.0.1 (legacy behaviour).
     * `rtsp_expose_to_lan=true` → bind 0.0.0.0, URL uses `rtsp_external_host`
     * (falls back to 127.0.0.1 if the field is empty — that still works for
     * tools running on the ioBroker host, just not for LAN recorders).
     */
    private _rtspBindConfig;
    /**
     * Build the public RTSP URL with embedded Digest credentials and the
     * query params Bosch cameras expect (inst, enableaudio, fmtp,
     * maxSessionDuration). Mirrors the HA integration's `local_rtsp_url`
     * shape in __init__.py.
     *
     * @param proxy
     * @param session
     */
    private _buildStreamUrl;
    /**
     * Replace `user:password@` with `***:***@` for log lines.
     *
     * @param url
     */
    private _maskCreds;
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
     * Periodic refetch of `/v11/video_inputs` to mirror app-side state changes
     * (privacy, in the future also name / firmware) into ioBroker DPs.
     *
     * Designed to be cheap — single GET, ~1–2 kB JSON per call, 30 s cadence.
     * Idempotent: re-calling while a timer is already armed is a no-op.
     * Stops itself on token expiry; the token-refresh loop will re-arm.
     */
    private _startStatePolling;
    /**
     * Single tick of the state poll: GET /v11/video_inputs, sync per-camera
     * fields that exist in that response back to DPs (currently just
     * privacy_enabled; light fields live on /lighting and aren't polled).
     */
    private _pollCameraStateOnce;
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
     * Inject a synthetic motion event for a camera.
     *
     * Writes last_motion_at + last_motion_event_type states exactly as FCM events do,
     * so downstream automations that listen for Bosch motion states fire immediately
     * without waiting for the real Bosch FCM push.
     *
     * Scope: ioBroker-local only. This DOES NOT cause a recording in the
     * Bosch cloud / Bosch app — the camera's own motion engine decides when
     * to record, and Bosch exposes no API to inject a recording externally.
     * Use this for ioBroker-side scenes/automations (light, scene, push),
     * not as a remote "record now" trigger. Forum #84538 post 10.
     *
     * Forum reference: ioBroker forum #84538 (Jaschkopf — Philips Hue in driveway).
     *
     * @param camId      Camera UUID
     * @param eventType  "motion" | "person" | "audio_alarm"
     */
    private triggerSyntheticMotion;
    /**
     * Trigger / silence the Gen2 panic-alarm siren.
     *
     * PUT /v11/video_inputs/{id}/panic_alarm body {"status": "ON"|"OFF"} → 204.
     * Stateful — the camera keeps blaring until OFF is sent (or its hardware
     * timeout fires, which Bosch hasn't documented; observed ~3 min).
     *
     * @param camId    Camera UUID (must be Gen2)
     * @param enabled  true → trigger siren, false → silence
     */
    private handleSirenToggle;
    /**
     * Apply a wallwasher (top + bottom LED) update to a Gen2 camera.
     *
     * The Bosch lighting/switch endpoint requires the full body — caller
     * passes only the delta and we merge into the cached state. If we have
     * no cache yet (first call after start, before the state-poll tick has
     * fetched), seed with `DEFAULT_LIGHTING_STATE` so the front spotlight
     * isn't accidentally re-enabled.
     *
     * Empty-string colour switches the LEDs to white-balance mode (warm
     * white). Use case: user clears the picker to "no colour".
     *
     * @param camId   Camera UUID (must be Gen2 with featureSupport.light)
     * @param delta   {brightness?, color?}  — only the changed fields
     * @param delta.brightness
     * @param delta.color
     */
    private handleWallwasherUpdate;
    /**
     * Switch the stream-quality preference for a camera and force a session
     * re-open so the new highQualityVideo flag takes effect immediately.
     *
     * The Bosch Cloud API only honours `highQualityVideo` at the
     * `PUT /v11/video_inputs/{id}/connection` call — it cannot be changed
     * on a live session. So we close the existing session (via DELETE),
     * drop the cached LiveSession, and let the next snapshot/stream call
     * re-open with the new flag.
     *
     * @param camId
     * @param quality  "high" or "low"
     */
    private handleStreamQualityChange;
    /**
     * Tear down everything that keeps a livestream alive for one camera:
     * session watchdog, TLS proxy, Bosch live session (DELETE /connection),
     * and the public stream_url DP. Used by:
     *   - the livestream toggle (user sets livestream_enabled=false)
     *   - the one-shot snapshot path when livestream is OFF (auto-cleanup
     *     so a single snapshot doesn't accidentally start 24/7 streaming).
     * Best-effort throughout — Bosch may have already closed the session
     * server-side after a transient network drop.
     *
     * @param camId  Camera UUID
     */
    private _teardownStream;
    /**
     * Start or stop the continuous RTSP livestream for one camera.
     * Default behaviour for the adapter is OFF — each open Bosch session
     * counts against the LOCAL daily quota, and the TLS proxy + RTSP
     * watchdog stay running 24/7 once armed. The user opts in per camera.
     *
     * @param camId    Camera UUID
     * @param enabled  true → ensureLiveSession (session + proxy + watchdog
     *                          + stream_url), false → _teardownStream
     */
    private handleLivestreamToggle;
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
     * v0.4.0: toggle the front spotlight only, keep wallwasher untouched.
     * Requested by ioBroker forum #84538 for dusk-sensor-driven group switching.
     *
     * @param camId
     * @param enabled
     */
    private handleFrontLightToggle;
    /**
     * v0.4.0: toggle the wallwasher (Gen1) / top-down LED strip (Gen2) only,
     * keep front spotlight untouched.
     *
     * @param camId
     * @param enabled
     */
    private handleWallwasherToggle;
    /**
     * Read a boolean state with default false (treats null/undefined/non-bool as false).
     *
     * @param id
     */
    private _readBoolState;
    /**
     * Single source of truth for the lighting REST calls. All three public
     * handlers (legacy combined, front-only, wallwasher-only) funnel through
     * here so we only have one place that knows the Bosch endpoints.
     *
     * Endpoint matrix:
     *   Gen1: PUT /v11/video_inputs/{id}/lighting_override
     *         body: { frontLightOn, wallwasherOn, frontLightIntensity? }
     *   Gen2: PUT /v11/video_inputs/{id}/lighting/switch/front   { enabled }
     *         PUT /v11/video_inputs/{id}/lighting/switch/topdown { enabled }
     *
     * After a successful call the per-light state objects are ack'd so that
     * `light_enabled` (legacy combined) and the two new datapoints stay in sync.
     *
     * @param camId
     * @param state
     * @param state.frontLight
     * @param state.wallwasher
     */
    private _applyLightingState;
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
     * Start the polling fallback: re-fetch /v11/events every 30 s.
     *
     * Activated only when FCM push registration fails for both iOS and Android.
     * Mirrors HA's `fcm_push_mode=polling` behaviour — adapter stays usable, just
     * with higher motion-event latency (~30 s vs. ~2 s with push).
     *
     * Idempotent: re-calling while a timer is already armed is a no-op.
     */
    private _startEventPolling;
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