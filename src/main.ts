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
// adapter-config.d.ts augments ioBroker.AdapterConfig — included via tsconfig src/**/*.ts,
// no runtime import needed (import would fail: .d.ts files produce no .js output)

import {
    generatePkcePair,
    buildAuthUrl,
    exchangeCode,
    extractCode,
    refreshAccessToken,
    createHttpClient,
    RefreshTokenInvalidError,
    type TokenResult,
} from "./lib/auth";

// login.ts is kept for tests / future headless paths but not called from here.
// See deprecation notice in src/lib/login.ts.
import { fetchCameras, type BoschCamera, UnauthorizedError } from "./lib/cameras";

import { openLiveSession, closeLiveSession, type LiveSession } from "./lib/live_session";

import { SessionWatchdog } from "./lib/session_watchdog";

// Note: rcp.ts (RCP+ commands) is no longer imported — all camera commands
// (privacy, light, image rotation) now use the Bosch Cloud API exclusively.

import { fetchSnapshot, buildSnapshotUrl } from "./lib/snapshot";

import { startTlsProxy, type TlsProxyHandle } from "./lib/tls_proxy";

import { FcmListener, FcmCbsRegistrationError, type FcmEventPayload } from "./lib/fcm";

import {
    setPanicAlarm,
    fetchLightingState,
    putLightingState,
    buildWallwasherUpdate,
    DEFAULT_LIGHTING_STATE,
    type LightingState,
} from "./lib/alarm_light";

// ── Types ─────────────────────────────────────────────────────────────────────

/** Internal token state read from ioBroker states at startup. */
interface StoredTokens {
    accessToken: string;
    refreshToken: string;
    expiresAt: number; // epoch ms
}

// ── Adapter class ─────────────────────────────────────────────────────────────

/**
 *
 */
class BoschSmartHomeCamera extends utils.Adapter {
    /** setTimeout handle for the token refresh re-arm loop (ioBroker.Timeout | null). */
    private _refreshTimeout: ioBroker.Timeout = null;

    /** Current refresh_token (kept in memory to avoid repeated state reads). */
    private _currentRefreshToken: string | null = null;

    /** Current access_token (kept in memory). */
    private _currentAccessToken: string | null = null;

    /** Cache: skip DB write when value is unchanged (iobroker.ring upsertState pattern). */
    private _stateCache = new Map<string, unknown>();

    /** Axios instance shared across all HTTP calls. */
    private _httpClient = createHttpClient();

    /** Live sessions keyed by camera ID. Re-opened when stale. */
    private _liveSessions = new Map<string, LiveSession>();

    /** TLS proxy handles keyed by camera ID. */
    private _tlsProxies = new Map<string, TlsProxyHandle>();

    /** Camera metadata keyed by camera ID (populated in onReady from fetchCameras). */
    private _cameras = new Map<string, BoschCamera>();

    /** FCM push listener (null until onReady wires it up). */
    private _fcmListener: FcmListener | null = null;

    /** RTSP session watchdogs keyed by camera ID. Renew LOCAL sessions before expiry. */
    private _sessionWatchdogs: Map<string, SessionWatchdog> = new Map();

    /**
     * Client-side image rotation flag per camera ID.
     * Bosch Cloud API has no rotation endpoint — flag is stored here so
     * downstream callers (snapshot post-processing, UI) can apply 180° transforms.
     */
    private _imageRotation: Record<string, boolean> = {};

    /**
     * Stream-quality preference per camera ID. v0.5.0 — controls the
     * `highQualityVideo` flag in PUT /v11/video_inputs/{id}/connection.
     * Default "high" (full bitrate). Changing this state forces the next
     * ensureLiveSession() to re-open with the new flag.
     */
    private _streamQuality: Map<string, "high" | "low"> = new Map();

    /**
     * ISO timestamp of the latest processed event per camera.
     * Used by fetchAndProcessEvents() to skip events we've already seen.
     * Keyed by camera ID. float('-inf') equivalent → empty string means "not seen".
     */
    private _lastSeenEventId: Record<string, string> = {};

    /**
     * Count of consecutive snapshot failures per camera ID.
     * Used to flip `online=false` only after a sustained outage, not on the first
     * transient network blip. Reset on every successful snapshot.
     */
    private _snapshotFailCount: Map<string, number> = new Map();

    /** Consecutive snapshot failures before a camera is marked offline. */
    private static readonly OFFLINE_THRESHOLD = 3;

    /**
     * Polling timer for /v11/events when FCM push registration failed.
     * Drives event ingestion without push so motion/audio events still surface.
     * Null when FCM is healthy (push is the primary path).
     */
    private _eventPollTimer: ReturnType<typeof setInterval> | null = null;

    /** Event-poll interval (ms) when FCM push is unavailable. */
    private static readonly EVENT_POLL_INTERVAL_MS = 30_000;

    /**
     * Periodic poll of /v11/video_inputs to pick up app-side state changes
     * (privacy toggled via the Bosch app, camera renamed, …). Independent of
     * FCM — runs always so DPs stay accurate even with push healthy.
     * Forum #84538: user set privacy_enabled via ioBroker, toggled it off
     * via the app, ioBroker DP stayed `true` because we only fetched once.
     */
    private _statePollTimer: ReturnType<typeof setInterval> | null = null;

    /** Camera-state poll interval (ms). */
    private static readonly STATE_POLL_INTERVAL_MS = 30_000;

    /**
     * Sticky TLS-proxy port per camera ID. Set on first proxy start
     * (ephemeral free port from the OS), then reused across session renewals
     * and adapter restarts so external recorders (BlueIris) keep working
     * without re-configuring the URL on every hourly session renewal.
     */
    private _stickyProxyPort = new Map<string, number>();

    /**
     * Remembered upstream LAN address (`<ip>:<port>`) per camera. Used by
     * `upsertSession()` to decide whether a renewed Bosch session points at
     * the same camera (→ keep the proxy + port intact) or at a different
     * address (→ tear down + restart).
     */
    private _sessionRemote = new Map<string, string>();

    /**
     * Desired siren (panic_alarm) state per Gen2 camera. The Bosch cloud has
     * no GET for this state — the iOS/Android apps keep their own copy and
     * we do the same. Wiped on adapter restart (camera also auto-stops the
     * siren after a hardware-defined timeout, so a stale `true` is fine to
     * forget).
     */
    private _sirenState = new Map<string, boolean>();

    /**
     * Cached lighting state per Gen2 camera (frontLight + topLed + bottomLed
     * brightness/color/whiteBalance). Seeded by the state-poll GET on the
     * `/lighting/switch` endpoint and updated from every PUT response. Used
     * to merge incremental DP writes into the full body Bosch requires.
     */
    private _lightingCache = new Map<string, LightingState>();

    /**
     * Whether a continuous live RTSP stream is active per camera ID.
     * Default: false (no livestream on adapter start — Bosch counts every
     * open session against the daily LOCAL session limit, so we don't want
     * to burn quota on cameras the user isn't actively watching). When
     * `cameras.<id>.livestream_enabled` is true, ensureLiveSession() keeps
     * the Bosch session + TLS proxy + watchdog alive; when false, the
     * adapter still opens short-lived sessions for snapshots but tears them
     * down after the idle window so no proxy/watchdog stays running.
     */
    private _livestreamEnabled = new Map<string, boolean>();

    /**
     * v0.5.3: pending "idle teardown" timer per camera (livestream OFF mode).
     * After each snapshot the timer is reset; when it finally fires we close
     * the Bosch session + TLS proxy + watchdog. Lets back-to-back
     * snapshot_trigger writes (e.g. a Card opening, an automation polling)
     * reuse the warm session instead of paying the PUT /connection cost
     * every time. Cleared eagerly on _teardownStream, livestream toggle ON,
     * and onUnload.
     */
    private _snapshotIdleTimers = new Map<string, ReturnType<typeof setTimeout>>();

    /**
     * Idle window after a snapshot before the session is torn down (ms).
     * Sized to match SESSION_TTL_MS in ensureLiveSession so a snapshot
     * burst within the window always reuses the cached session instead of
     * forcing a fresh `PUT /v11/.../connection`.
     */
    private static readonly SNAPSHOT_SESSION_IDLE_MS = 60_000;

    /**
     * v0.5.3: per-camera "motion_active=true" auto-clear timers. When a
     * motion event fires we set motion_active=true; this timer flips it
     * back to false after MOTION_ACTIVE_WINDOW_MS so automations have a
     * clean rising/falling edge to listen on. Re-armed (window slides) on
     * every follow-up event within the window.
     */
    private _motionActiveTimers = new Map<string, ReturnType<typeof setTimeout>>();

    /**
     * How long `cameras.<id>.motion_active` stays true after the last
     * motion event before auto-clearing (ms). Mirrors the HA integration's
     * EVENT_ACTIVE_WINDOW (90 s) — long enough that a person walking
     * through the frame keeps the boolean high through the whole pass,
     * short enough that a real motion gap (no events for >90 s) flips it
     * back to false.
     */
    private static readonly MOTION_ACTIVE_WINDOW_MS = 90_000;

    /**
     *
     * @param options
     */
    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({
            ...options,
            name: "bosch-smart-home-camera",
        });

        this.on("ready", this.onReady.bind(this));
        this.on("stateChange", this.onStateChange.bind(this));
        this.on("unload", this.onUnload.bind(this));
        this.on("message", this.onMessage.bind(this));
    }

    /**
     * v0.5.4: handle sendTo messages from Admin UI.
     *
     * Commands:
     *   - "getLoginUrl": return the current info.login_url value so the Admin
     *     UI can render a "Login bei Bosch" button that opens the URL in a
     *     new tab without forcing the user to copy a 300-char log line.
     *   - "resetLogin": clear all OAuth state (tokens, PKCE pair, pasted URL)
     *     and generate a fresh login URL. Used when a user is stuck in an
     *     auth_error loop or wants to log in with a different Bosch account.
     *
     * @param obj Inbound ioBroker message from Admin (carries command, from, callback).
     */
    private async onMessage(obj: ioBroker.Message): Promise<void> {
        if (!obj || typeof obj !== "object") {
            return;
        }

        if (obj.command === "getLoginUrl") {
            const state = await this.getStateAsync("info.login_url");
            const url = typeof state?.val === "string" ? state.val : "";
            if (obj.callback) {
                if (url) {
                    this.sendTo(obj.from, obj.command, { openUrl: url }, obj.callback);
                } else {
                    this.sendTo(
                        obj.from,
                        obj.command,
                        {
                            error: "Already logged in or login URL not yet generated. Use 'Reset login' to start a fresh login.",
                        },
                        obj.callback,
                    );
                }
            }
            return;
        }

        if (obj.command === "resetLogin") {
            try {
                // Clear persisted tokens + paste field so a fresh PKCE cycle
                // starts on the next adapter restart.
                await this.setStateAsync("info.access_token", "", true);
                await this.setStateAsync("info.refresh_token", "", true);
                await this.setStateAsync("info.token_expires_at", 0, true);
                await this.setStateAsync("info.pkce_verifier", "", true);
                await this.setStateAsync("info.pkce_state", "", true);
                await this.setStateAsync("info.login_url", "", true);
                await this.setStateAsync("info.connection", false, true);
                await this.setStateAsync("info.connection_status", "logged_out", true);
                try {
                    await this.extendForeignObjectAsync(`system.adapter.${this.namespace}`, {
                        native: { redirect_url: "" } as Partial<ioBroker.AdapterConfig>,
                    });
                } catch {
                    this.log.debug("resetLogin: could not clear redirect_url — non-fatal");
                }
                this._currentAccessToken = null;
                this._currentRefreshToken = null;
                this.log.info("Login state reset — adapter will restart to begin a fresh login.");
                if (obj.callback) {
                    this.sendTo(
                        obj.from,
                        obj.command,
                        {
                            result: "ok",
                            message: "Login state cleared. The adapter is restarting.",
                        },
                        obj.callback,
                    );
                }
                // Trigger a restart so onReady re-runs the showLoginUrl path.
                this.terminate("Login reset requested via Admin UI", 11);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                this.log.error(`resetLogin failed: ${msg}`);
                if (obj.callback) {
                    this.sendTo(obj.from, obj.command, { error: msg }, obj.callback);
                }
            }
            return;
        }
    }

    // ── State helpers ───────────────────────────────────────────────────────

    /**
     * Write a state only if the value changed (iobroker.ring upsertState pattern).
     * Always creates the object if it doesn't exist yet, then sets ack=true.
     *
     * @param id
     * @param value
     */
    private async upsertState(id: string, value: unknown): Promise<void> {
        if (this._stateCache.get(id) === value) {
            return;
        }
        this._stateCache.set(id, value);
        await this.setStateAsync(id, value as ioBroker.StateValue, true);
    }

    // ── Object creation ─────────────────────────────────────────────────────

    /** Ensure the info channel + connection/token states exist. */
    private async ensureInfoObjects(): Promise<void> {
        // info.connection is pre-created via instanceObjects in io-package.json,
        // but we defensively create it here too so tests pass without a full ioBroker host.
        await this.setObjectNotExistsAsync("info", {
            type: "channel",
            common: { name: "Adapter information" },
            native: {},
        });

        // Root "meta" object is required by ioBroker's writeFileAsync() to be able
        // to store binary files under bosch-smart-home-camera.0/<path>. Without it
        // writeFileAsync throws "is not an object of type 'meta'". The object_id
        // must be the full namespace ("bosch-smart-home-camera.0") which is foreign
        // from the adapter's perspective (it manages bosch-smart-home-camera.0.*),
        // hence extendForeignObject. We only set if missing — never clobber.
        try {
            const existing = await this.getForeignObjectAsync(this.namespace);
            if (!existing) {
                await this.setForeignObjectAsync(this.namespace, {
                    type: "meta",
                    common: {
                        name: "Bosch Smart Home Camera adapter data",
                        type: "meta.folder",
                    } as unknown as ioBroker.MetaCommon,
                    native: {},
                });
            }
        } catch (err) {
            this.log.warn(
                `Could not ensure meta object for file storage: ${(err as Error).message}`,
            );
        }

        await this.setObjectNotExistsAsync("info.connection", {
            type: "state",
            common: {
                role: "indicator.connected",
                name: "Connected to Bosch cloud",
                type: "boolean",
                read: true,
                write: false,
                def: false,
            },
            native: {},
        });

        // Token states — read-only, user must not edit these.
        // Stored here so they survive adapter restarts without a new login.
        await this.setObjectNotExistsAsync("info.access_token", {
            type: "state",
            common: {
                role: "text",
                name: "OAuth2 access token",
                type: "string",
                read: true,
                write: false,
                def: "",
            },
            native: {},
        });

        await this.setObjectNotExistsAsync("info.refresh_token", {
            type: "state",
            common: {
                role: "text",
                name: "OAuth2 refresh token",
                type: "string",
                read: true,
                write: false,
                def: "",
            },
            native: {},
        });

        await this.setObjectNotExistsAsync("info.token_expires_at", {
            type: "state",
            common: {
                role: "value.time",
                name: "Token expiry (epoch ms)",
                type: "number",
                read: true,
                write: false,
                def: 0,
            },
            native: {},
        });

        await this.setObjectNotExistsAsync("info.fcm_active", {
            type: "state",
            common: {
                role: "indicator.status",
                name: "FCM push listener status: healthy / polling / disconnected / error / stub / stopped",
                type: "string",
                read: true,
                write: false,
                def: "stub",
            },
            native: {},
        });

        // PKCE verifier + state stored across restarts so a stale URL still works
        // (regenerated only after successful code exchange or explicit reset).
        await this.setObjectNotExistsAsync("info.pkce_verifier", {
            type: "state",
            common: {
                role: "text",
                name: "PKCE code_verifier (internal — do not share)",
                type: "string",
                read: true,
                write: false,
                def: "",
            },
            native: {},
        });

        await this.setObjectNotExistsAsync("info.pkce_state", {
            type: "state",
            common: {
                role: "text",
                name: "OIDC state parameter (CSRF protection — internal)",
                type: "string",
                read: true,
                write: false,
                def: "",
            },
            native: {},
        });

        // v0.5.4: surface the Bosch OAuth URL as a datapoint so the Admin UI
        // can render it as a clickable link instead of forcing users to fish
        // a 300-char log line out of the Log Inspector (Forum #84538 feedback).
        await this.setObjectNotExistsAsync("info.login_url", {
            type: "state",
            common: {
                role: "url",
                name: "Bosch OAuth login URL — open in browser when set",
                type: "string",
                read: true,
                write: false,
                def: "",
            },
            native: {},
        });

        // v0.5.4: text state for richer connection diagnostics than the boolean
        // info.connection — Blockly / VIS can branch on the specific phase.
        await this.setObjectNotExistsAsync("info.connection_status", {
            type: "state",
            common: {
                role: "indicator.state",
                name: "Adapter login phase (logged_out | awaiting_login | connected | auth_error)",
                type: "string",
                read: true,
                write: false,
                def: "logged_out",
                states: {
                    logged_out: "logged out",
                    awaiting_login: "awaiting login",
                    connected: "connected",
                    auth_error: "auth error",
                },
            },
            native: {},
        });

        // v0.5.4: timestamp of the most recent successful token mint (either
        // fresh PKCE login or silent refresh). Helps users diagnose how stale
        // the refresh_token is — Bosch's offline_access tokens live ~30 days.
        await this.setObjectNotExistsAsync("info.last_login_at", {
            type: "state",
            common: {
                role: "date",
                name: "Timestamp of last successful Bosch token mint (ISO 8601)",
                type: "string",
                read: true,
                write: false,
                def: "",
            },
            native: {},
        });
    }

    /**
     * Create the cameras device + one channel per camera.
     * Uses setObjectNotExistsAsync to preserve user history config.
     *
     * @param cameras
     */
    private async ensureCameraObjects(cameras: BoschCamera[]): Promise<void> {
        // Top-level "cameras" device
        await this.setObjectNotExistsAsync("cameras", {
            type: "device",
            common: { name: "Bosch cameras" },
            native: {},
        });

        for (const cam of cameras) {
            const prefix = `cameras.${cam.id}`;

            // Channel per camera
            await this.setObjectNotExistsAsync(prefix, {
                type: "channel",
                common: { name: cam.name },
                native: {},
            });

            await this.setObjectNotExistsAsync(`${prefix}.name`, {
                type: "state",
                common: {
                    role: "text",
                    name: "Camera name",
                    type: "string",
                    read: true,
                    write: false,
                },
                native: {},
            });

            await this.setObjectNotExistsAsync(`${prefix}.firmware_version`, {
                type: "state",
                common: {
                    role: "text",
                    name: "Firmware version",
                    type: "string",
                    read: true,
                    write: false,
                },
                native: {},
            });

            await this.setObjectNotExistsAsync(`${prefix}.hardware_version`, {
                type: "state",
                common: {
                    role: "text",
                    name: "Hardware version / model",
                    type: "string",
                    read: true,
                    write: false,
                },
                native: {},
            });

            await this.setObjectNotExistsAsync(`${prefix}.generation`, {
                type: "state",
                common: {
                    role: "value",
                    name: "Camera generation (1 or 2)",
                    type: "number",
                    read: true,
                    write: false,
                },
                native: {},
            });

            await this.setObjectNotExistsAsync(`${prefix}.online`, {
                type: "state",
                common: {
                    role: "indicator.connected",
                    name: "Camera online",
                    type: "boolean",
                    read: true,
                    write: false,
                    def: false,
                },
                native: {},
            });

            // Writable states — user commands
            await this.setObjectNotExistsAsync(`${prefix}.privacy_enabled`, {
                type: "state",
                common: {
                    name: "Privacy mode (camera dark)",
                    role: "switch",
                    type: "boolean",
                    read: true,
                    write: true,
                    def: false,
                },
                native: {},
            });

            await this.setObjectNotExistsAsync(`${prefix}.light_enabled`, {
                type: "state",
                common: {
                    name: "Camera light (legacy — toggles both front_light + wallwasher)",
                    role: "switch.light",
                    type: "boolean",
                    read: true,
                    write: true,
                    def: false,
                },
                native: {},
            });

            // v0.4.0: separate front light + wallwasher datapoints so external
            // sensors (dusk script, motion → wallwasher-only, etc.) can drive
            // each light source individually. Mirrors Bosch's own /lighting_override
            // (Gen1) and /lighting/switch/{front,topdown} (Gen2) split.
            await this.setObjectNotExistsAsync(`${prefix}.front_light_enabled`, {
                type: "state",
                common: {
                    name: "Front spotlight (Gen1 frontLight / Gen2 front)",
                    role: "switch.light",
                    type: "boolean",
                    read: true,
                    write: true,
                    def: false,
                },
                native: {},
            });

            await this.setObjectNotExistsAsync(`${prefix}.wallwasher_enabled`, {
                type: "state",
                common: {
                    name: "Wallwasher / top-down LED strip (Gen1 wallwasher / Gen2 topdown)",
                    role: "switch.light",
                    type: "boolean",
                    read: true,
                    write: true,
                    def: false,
                },
                native: {},
            });

            // v0.5.1: integrated 75 dB siren (Gen2 only). Backed by
            // PUT /v11/video_inputs/{id}/panic_alarm body {"status": "ON"|"OFF"} (204).
            // Stateful — siren keeps blaring until OFF is sent. The Bosch
            // cloud has no GET for this state, so the DP reflects the
            // adapter's last write (cleared on restart).
            if (cam.generation >= 2) {
                await this.setObjectNotExistsAsync(`${prefix}.siren_active`, {
                    type: "state",
                    common: {
                        name: "Siren (75 dB panic alarm) — write true to trigger, false to silence",
                        role: "switch",
                        type: "boolean",
                        read: true,
                        write: true,
                        def: false,
                    },
                    native: {},
                });
            }

            // v0.5.1: Gen2 RGB lighting (Eyes Outdoor II + Indoor II) — backed
            // by PUT /v11/video_inputs/{id}/lighting/switch. The user-facing
            // "wallwasher" concept maps to top+bottom LED groups together
            // (front spotlight has white-balance only, no RGB).
            //   wallwasher_color      — string  "#RRGGBB" or "" (= white-balance)
            //   wallwasher_brightness — number  0..100
            // Gated on featureSupport.light so cams without the multi-LED rig
            // don't get useless DPs.
            if (cam.generation >= 2 && cam.featureLight === true) {
                await this.setObjectNotExistsAsync(`${prefix}.wallwasher_color`, {
                    type: "state",
                    common: {
                        name: "Wallwasher RGB colour (Gen2 top+bottom LEDs) — HEX, empty = white",
                        role: "level.color.rgb",
                        type: "string",
                        read: true,
                        write: true,
                        def: "",
                    },
                    native: {},
                });
                await this.setObjectNotExistsAsync(`${prefix}.wallwasher_brightness`, {
                    type: "state",
                    common: {
                        name: "Wallwasher brightness (Gen2 top+bottom LEDs) 0..100",
                        role: "level.brightness",
                        type: "number",
                        min: 0,
                        max: 100,
                        unit: "%",
                        read: true,
                        write: true,
                        def: 0,
                    },
                    native: {},
                });
            }

            // Indoor-only in practice — created for all cameras; can be filtered later by generation/hardwareVersion
            await this.setObjectNotExistsAsync(`${prefix}.image_rotation_180`, {
                type: "state",
                common: {
                    name: "Image rotated 180° (ceiling mount)",
                    role: "switch",
                    type: "boolean",
                    read: true,
                    write: true,
                    def: false,
                },
                native: {},
            });

            await this.setObjectNotExistsAsync(`${prefix}.snapshot_trigger`, {
                type: "state",
                common: {
                    name: "Trigger snapshot refresh (write true to fetch new)",
                    role: "button",
                    type: "boolean",
                    read: false,
                    write: true,
                    def: false,
                },
                native: {},
            });

            // v0.4.0: synthetic motion trigger — lets external sensors (Hue, etc.)
            // inject a motion event so automations listening for Bosch motion fire
            // without waiting for the real Bosch FCM push.
            // Forum reference: ioBroker forum #84538 (Jaschkopf).
            //
            // IMPORTANT: this only updates ioBroker DPs (`last_motion_at`,
            // `last_motion_event_type`). It does NOT cause a recording in the
            // Bosch app — the camera's cloud-side motion engine decides when
            // to record and we have no API to inject that. Forum #84538 post 10.
            await this.setObjectNotExistsAsync(`${prefix}.motion_trigger`, {
                type: "state",
                common: {
                    name:
                        "Inject synthetic motion event for ioBroker automations " +
                        "(updates last_motion_at — does NOT create a Bosch-app recording)",
                    role: "button",
                    type: "boolean",
                    read: false,
                    write: true,
                    def: false,
                },
                native: {},
            });

            await this.setObjectNotExistsAsync(`${prefix}.motion_trigger_event_type`, {
                type: "state",
                common: {
                    name: "Event type for synthetic motion trigger",
                    role: "text",
                    type: "string",
                    read: true,
                    write: true,
                    def: "motion",
                    states: {
                        motion: "motion",
                        person: "person",
                        audio_alarm: "audio_alarm",
                    },
                },
                native: {},
            });

            await this.setObjectNotExistsAsync(`${prefix}.snapshot_path`, {
                type: "state",
                common: {
                    name: "Path to last fetched snapshot JPEG (in adapter data folder)",
                    role: "text.url",
                    type: "string",
                    read: true,
                    write: false,
                    def: "",
                },
                native: {},
            });

            await this.setObjectNotExistsAsync(`${prefix}.stream_url`, {
                type: "state",
                common: {
                    name: "Local RTSP URL for RTSPS stream (copy into go2rtc / iobroker.cameras)",
                    role: "text.url",
                    type: "string",
                    read: true,
                    write: false,
                    def: "",
                },
                native: {},
            });

            // v0.5.2: explicit on/off switch for the continuous RTSP livestream.
            // Default OFF so adapter start never auto-opens long-running Bosch
            // sessions (each open session counts against the daily LOCAL quota
            // and keeps the TLS proxy + RTSP watchdog running 24/7). Set true
            // to start streaming; set false to tear down the proxy/watchdog
            // and free the Bosch session. Snapshots work regardless — they
            // open a short-lived session that closes right after the JPEG.
            await this.setObjectNotExistsAsync(`${prefix}.livestream_enabled`, {
                type: "state",
                common: {
                    name: "Continuous RTSP livestream — write true to start, false to stop (default OFF)",
                    role: "switch.enable",
                    type: "boolean",
                    read: true,
                    write: true,
                    def: false,
                },
                native: {},
            });

            // v0.5.0: stream quality preference. Toggling this state closes the
            // current LOCAL session and opens a new one with the matching
            // highQualityVideo flag — useful for mobile dashboards / metered
            // links where the full-bitrate primary stream wastes bandwidth.
            await this.setObjectNotExistsAsync(`${prefix}.stream_quality`, {
                type: "state",
                common: {
                    name: "Stream quality: high (full bitrate) / low (bandwidth saver)",
                    role: "level.mode",
                    type: "string",
                    read: true,
                    write: true,
                    def: "high",
                    states: {
                        high: "High (full bitrate)",
                        low: "Low (bandwidth saver)",
                    },
                },
                native: {},
            });

            await this.setObjectNotExistsAsync(`${prefix}.last_motion_at`, {
                type: "state",
                common: {
                    name: "Timestamp of last motion/person/audio event (ISO 8601)",
                    role: "value.time",
                    type: "string",
                    read: true,
                    write: false,
                    def: "",
                },
                native: {},
            });

            await this.setObjectNotExistsAsync(`${prefix}.last_motion_event_type`, {
                type: "state",
                common: {
                    name: "Type of last event: motion / person / audio_alarm",
                    role: "text",
                    type: "string",
                    read: true,
                    write: false,
                    def: "",
                },
                native: {},
            });

            // v0.5.3: edge-trigger boolean for automations. Goes true on every
            // motion/person/audio_alarm event and auto-clears after
            // MOTION_ACTIVE_WINDOW_MS (default 90 s) so Blockly etc. can
            // listen for the rising edge instead of having to diff timestamps.
            await this.setObjectNotExistsAsync(`${prefix}.motion_active`, {
                type: "state",
                common: {
                    name: "True while a motion/person/audio event is recent (auto-clears after ~90 s)",
                    role: "sensor.motion",
                    type: "boolean",
                    read: true,
                    write: false,
                    def: false,
                },
                native: {},
            });

            // v0.5.3: base64 JPEG of the snapshot taken right when motion fired.
            // Use this for Telegram/Signal/Matrix push pipelines that consume
            // a base64 image directly — no need to read the file store.
            // String length can reach ~150 kB; ioBroker handles that fine.
            await this.setObjectNotExistsAsync(`${prefix}.last_event_image`, {
                type: "state",
                common: {
                    name: "Base64-encoded JPEG fetched on the last motion event (for Telegram/Signal/Matrix push)",
                    role: "text",
                    type: "string",
                    read: true,
                    write: false,
                    def: "",
                },
                native: {},
            });

            // v0.5.3: timestamp matching last_event_image, so consumers can
            // tell whether the base64 buffer is the current event's snap or
            // a leftover from an earlier event when auto-snapshot was off.
            await this.setObjectNotExistsAsync(`${prefix}.last_event_image_at`, {
                type: "state",
                common: {
                    name: "Timestamp of the JPEG in last_event_image (ISO 8601)",
                    role: "value.time",
                    type: "string",
                    read: true,
                    write: false,
                    def: "",
                },
                native: {},
            });

            // v0.5.3: dual-stream — sub-stream URL via inst=2 (CPP6 firmware
            // serves up to 4 video instances per encoder; Bosch cameras
            // typically expose inst=1 (main, high bitrate) + inst=2 (sub,
            // lower bitrate). Experimental: if your camera firmware doesn't
            // serve inst=2, the URL returns RTSP SETUP error and BlueIris/
            // Frigate just won't connect — main stream is unaffected.
            await this.setObjectNotExistsAsync(`${prefix}.stream_url_sub`, {
                type: "state",
                common: {
                    name: "Sub-stream RTSP URL (inst=2, lower bitrate) — experimental, depends on camera firmware",
                    role: "text.url",
                    type: "string",
                    read: true,
                    write: false,
                    def: "",
                },
                native: {},
            });

            // Set initial values
            await this.upsertState(`${prefix}.name`, cam.name);
            await this.upsertState(`${prefix}.firmware_version`, cam.firmwareVersion);
            await this.upsertState(`${prefix}.hardware_version`, cam.hardwareVersion);
            await this.upsertState(`${prefix}.generation`, cam.generation);
            await this.upsertState(`${prefix}.online`, cam.online);

            // Seed in-memory livestream flag from the persisted state so a
            // restart preserves whatever the user toggled before. Default
            // false when no state exists yet (fresh install).
            const lsState = await this.getStateAsync(`${prefix}.livestream_enabled`);
            this._livestreamEnabled.set(cam.id, lsState?.val === true);
        }
    }

    // ── Token persistence ───────────────────────────────────────────────────

    /**
     * Save tokens to ioBroker states (survives adapter restart).
     *
     * @param tokens
     */
    private async saveTokens(tokens: TokenResult): Promise<void> {
        const expiresAt = Date.now() + tokens.expires_in * 1000;
        this._currentAccessToken = tokens.access_token;
        this._currentRefreshToken = tokens.refresh_token;
        await this.upsertState("info.access_token", tokens.access_token);
        await this.upsertState("info.refresh_token", tokens.refresh_token);
        await this.upsertState("info.token_expires_at", expiresAt);
        // v0.5.4: diagnostics — both Blockly and VIS dashboards can branch on these.
        await this.setStateAsync("info.last_login_at", new Date().toISOString(), true);
        await this.setStateAsync("info.connection_status", "connected", true);
    }

    /**
     * Load tokens from ioBroker states (from a previous run).
     * Returns null if tokens are absent or already expired.
     */
    private async loadStoredTokens(): Promise<StoredTokens | null> {
        const [atState, rtState, expState] = await Promise.all([
            this.getStateAsync("info.access_token"),
            this.getStateAsync("info.refresh_token"),
            this.getStateAsync("info.token_expires_at"),
        ]);

        const accessToken = typeof atState?.val === "string" ? atState.val : "";
        const refreshToken = typeof rtState?.val === "string" ? rtState.val : "";
        const expiresAt = typeof expState?.val === "number" ? expState.val : 0;

        if (!accessToken || !refreshToken || !expiresAt) {
            return null;
        }

        // Consider expired if within 60s of expiry (gives room for the refresh call itself)
        if (Date.now() >= expiresAt - 60_000) {
            return null;
        }

        return { accessToken, refreshToken, expiresAt };
    }

    // ── Token refresh loop (setTimeout re-arm pattern) ──────────────────────

    /**
     * Schedule the next token refresh at 75% of remaining token lifetime.
     * Uses this.setTimeout (adapter-core) so ioBroker auto-cancels on unload.
     *
     * @param expiresInMs  Milliseconds until the current access_token expires.
     */
    private scheduleTokenRefresh(expiresInMs: number): void {
        // Refresh at 75% of token lifetime — leaves a safety buffer before expiry.
        const refreshIn = Math.max(60_000, expiresInMs * 0.75);

        // this.setTimeout returns ioBroker.Timeout | undefined — cast via unknown to normalise
        this._refreshTimeout =
            this.setTimeout(async () => {
                this._refreshTimeout = null;
                if (!this._currentRefreshToken) {
                    this.log.warn("Token refresh skipped — no refresh token in memory");
                    return;
                }

                try {
                    const newTokens = await refreshAccessToken(
                        this._httpClient,
                        this._currentRefreshToken,
                    );

                    if (!newTokens) {
                        // Transient network error — retry in 5 min
                        this.log.warn("Token refresh returned null (network) — retrying in 5 min");
                        this.scheduleTokenRefresh(5 * 60_000);
                        return;
                    }

                    await this.saveTokens(newTokens);
                    this.log.debug(
                        `Token refresh successful — next refresh in ~${Math.round(
                            (newTokens.expires_in * 0.75) / 60,
                        )} min`,
                    );
                    this.scheduleTokenRefresh(newTokens.expires_in * 1000);
                } catch (err: unknown) {
                    if (err instanceof RefreshTokenInvalidError) {
                        this.log.error(
                            "Refresh token invalid — please reconfigure credentials in Admin UI",
                        );
                        await this.setStateAsync("info.connection", false, true);
                        // Do NOT re-arm — user must re-configure and restart the adapter
                    } else {
                        // AuthServerOutageError or unexpected — retry in 5 min
                        const msg = err instanceof Error ? err.message : String(err);
                        this.log.warn(`Token refresh failed: ${msg} — retrying in 5 min`);
                        this.scheduleTokenRefresh(5 * 60_000);
                    }
                }
            }, refreshIn) ?? null;
    }

    // ── Live session management ─────────────────────────────────────────────

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
    private async ensureLiveSession(camId: string): Promise<LiveSession> {
        // v0.5.3: bumped from 30 s → 60 s so a snapshot burst inside the
        // SNAPSHOT_SESSION_IDLE_MS keep-alive window can always reuse the
        // cached session. Watchdog handles real session renewal at ~T-60s
        // before maxSessionDuration; this TTL is only a safety net against
        // an externally-killed session (camera reboot, cloud-side close).
        const SESSION_TTL_MS = 60_000;

        const existing = this._liveSessions.get(camId);
        if (existing && Date.now() - existing.openedAt < SESSION_TTL_MS) {
            return existing; // still fresh
        }

        if (!this._currentAccessToken) {
            throw new Error(`Cannot open live session for ${camId} — no access token`);
        }

        // Open a fresh LOCAL session — throws if camera unreachable on LAN
        const highQuality = (this._streamQuality.get(camId) ?? "high") === "high";
        const session = await openLiveSession(
            this._httpClient,
            this._currentAccessToken,
            camId,
            highQuality,
        );
        this._liveSessions.set(camId, session);

        // Spawn (or replace) TLS proxy + update stream_url + arm watchdog
        await this.upsertSession(camId, session);

        // Arm session watchdog if not already running
        if (!this._sessionWatchdogs.has(camId)) {
            const watchdog = new SessionWatchdog({
                openSession: () => {
                    if (!this._currentAccessToken) {
                        return Promise.reject(
                            new Error(`Cannot renew session for ${camId} — no access token`),
                        );
                    }
                    const hq = (this._streamQuality.get(camId) ?? "high") === "high";
                    return openLiveSession(this._httpClient, this._currentAccessToken, camId, hq);
                },
                onRenew: async (newSession: LiveSession) => {
                    this._liveSessions.set(camId, newSession);
                    await this.upsertSession(camId, newSession);
                },
                onError: (err: Error) => {
                    this.log.warn(
                        `RTSP watchdog: LOCAL renewal failed for camera ${camId.slice(0, 8)} — ` +
                            `stream will stop: ${err.message}`,
                    );
                    // Stop the TLS proxy and clear both stream URLs (main + sub)
                    const proxy = this._tlsProxies.get(camId);
                    if (proxy) {
                        void proxy.stop().catch(() => undefined);
                        this._tlsProxies.delete(camId);
                    }
                    void this.upsertState(`cameras.${camId}.stream_url`, "");
                    void this.upsertState(`cameras.${camId}.stream_url_sub`, "");
                    this._sessionWatchdogs.delete(camId);
                },
                log: (level, msg) => this.log[level](msg),
            });
            watchdog.start(session);
            this._sessionWatchdogs.set(camId, watchdog);
        }

        return session;
    }

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
    private async upsertSession(camId: string, session: LiveSession): Promise<void> {
        try {
            // lanAddress: "192.168.x.x:443" — always LOCAL
            const [h, pStr] = session.lanAddress.split(":");
            const remoteHost = h;
            const remotePort = parseInt(pStr ?? "443", 10);

            // ── Hot-reuse: same upstream + alive proxy → just refresh stream_url
            // with the new Digest credentials. Keeps port stable across renewals.
            const existingProxy = this._tlsProxies.get(camId);
            const existingRemote = this._sessionRemote.get(camId);
            const remoteUnchanged = existingRemote === `${remoteHost}:${remotePort}`;

            let proxyHandle: TlsProxyHandle;
            if (existingProxy && remoteUnchanged) {
                proxyHandle = existingProxy;
                this.log.debug(
                    `TLS proxy for ${camId.slice(0, 8)}: reusing port ${proxyHandle.port} ` +
                        `(remote unchanged ${remoteHost}:${remotePort})`,
                );
            } else {
                if (existingProxy) {
                    await existingProxy.stop().catch(() => undefined);
                    this._tlsProxies.delete(camId);
                }

                // Sticky-port: prefer the previously used port if known
                let preferredPort = this._stickyProxyPort.get(camId);
                if (preferredPort === undefined) {
                    const persisted = await this.getStateAsync(`cameras.${camId}._proxy_port`);
                    const v = persisted?.val;
                    if (typeof v === "number" && v > 0 && v < 65_536) {
                        preferredPort = v;
                    }
                }

                const { bindHost, urlHost } = this._rtspBindConfig();

                // v0.5.3: forward the session's Digest creds to the proxy so
                // it can handle auth transparently for clients that don't.
                const digestAuth = {
                    user: session.digestUser,
                    password: session.digestPassword,
                };
                try {
                    proxyHandle = await startTlsProxy({
                        remoteHost,
                        remotePort,
                        cameraId: camId,
                        localPort: preferredPort,
                        bindHost,
                        urlHost,
                        digestAuth,
                        log: (level, msg) => this.log[level](msg),
                    });
                } catch (bindErr: unknown) {
                    // Sticky port no longer available — fall back to ephemeral
                    const msg = bindErr instanceof Error ? bindErr.message : String(bindErr);
                    if (preferredPort !== undefined) {
                        this.log.warn(
                            `TLS proxy for ${camId.slice(0, 8)}: sticky port ${preferredPort} ` +
                                `unavailable (${msg}) — falling back to ephemeral port`,
                        );
                        proxyHandle = await startTlsProxy({
                            remoteHost,
                            remotePort,
                            cameraId: camId,
                            bindHost,
                            urlHost,
                            digestAuth,
                            log: (level, msg2) => this.log[level](msg2),
                        });
                    } else {
                        throw bindErr;
                    }
                }
                this._tlsProxies.set(camId, proxyHandle);
                this._sessionRemote.set(camId, `${remoteHost}:${remotePort}`);
                this._stickyProxyPort.set(camId, proxyHandle.port);

                // Persist sticky port so it survives adapter restart
                await this.setObjectNotExistsAsync(`cameras.${camId}._proxy_port`, {
                    type: "state",
                    common: {
                        name: "Sticky TLS proxy port (auto-managed)",
                        role: "value",
                        type: "number",
                        read: true,
                        write: false,
                        def: 0,
                    },
                    native: {},
                });
                await this.upsertState(`cameras.${camId}._proxy_port`, proxyHandle.port);
            }

            // Build the public URL with Digest credentials + RTSP query params.
            // Bosch RTSP demands Digest auth; without `user:pass@…` consumers
            // (cameras adapter, BlueIris, FFmpeg without separate auth) return
            // "401 Unauthorized". The query params mirror what HA / Python CLI
            // build: inst=1 (main), enableaudio=1, fmtp=1, maxSessionDuration.
            // v0.5.3: also publish inst=2 (sub-stream) under stream_url_sub so
            // BlueIris / Frigate can do mainstream-record + substream-display
            // and save CPU. Same Bosch session, same TLS proxy, same auth.
            const credsUrl = this._buildStreamUrl(proxyHandle, session, 1);
            const subUrl = this._buildStreamUrl(proxyHandle, session, 2);

            await this.setObjectNotExistsAsync(`cameras.${camId}.stream_url`, {
                type: "state",
                common: {
                    name: "Local RTSP URL — auth handled transparently by the proxy",
                    role: "text.url",
                    type: "string",
                    read: true,
                    write: false,
                    def: "",
                },
                native: {},
            });
            await this.upsertState(`cameras.${camId}.stream_url`, credsUrl);
            await this.upsertState(`cameras.${camId}.stream_url_sub`, subUrl);
            this.log.info(
                `TLS proxy for camera ${camId.slice(0, 8)}: ` +
                    `stream_url = ${credsUrl} | stream_url_sub = ${subUrl}`,
            );
        } catch (proxyErr: unknown) {
            // TLS proxy failure is non-fatal for RCP/snapshot — log and continue
            const msg = proxyErr instanceof Error ? proxyErr.message : String(proxyErr);
            this.log.warn(`Could not start TLS proxy for ${camId}: ${msg}`);
        }
    }

    /**
     * Resolve the RTSP proxy bind host + URL host from adapter config.
     * Default: bind 127.0.0.1, URL uses 127.0.0.1 (legacy behaviour).
     * `rtsp_expose_to_lan=true` → bind 0.0.0.0, URL uses `rtsp_external_host`
     * (falls back to 127.0.0.1 if the field is empty — that still works for
     * tools running on the ioBroker host, just not for LAN recorders).
     */
    private _rtspBindConfig(): { bindHost: string; urlHost: string } {
        const exposeLan = this.config.rtsp_expose_to_lan === true;
        if (!exposeLan) {
            return { bindHost: "127.0.0.1", urlHost: "127.0.0.1" };
        }
        const ext =
            typeof this.config.rtsp_external_host === "string"
                ? this.config.rtsp_external_host.trim()
                : "";
        return { bindHost: "0.0.0.0", urlHost: ext || "127.0.0.1" };
    }

    /**
     * Build the public RTSP URL with embedded Digest credentials and the
     * query params Bosch cameras expect (inst, enableaudio, fmtp,
     * maxSessionDuration). Mirrors the HA integration's `local_rtsp_url`
     * shape in __init__.py.
     *
     * @param proxy
     * @param session
     */
    private _buildStreamUrl(
        proxy: TlsProxyHandle,
        session: LiveSession,
        instance: 1 | 2 = 1,
    ): string {
        // v0.5.3: stream URL no longer embeds Digest credentials. The TLS
        // proxy now handles RTSP Digest auth itself (see lib/rtsp_auth.ts),
        // so consumers get a clean `rtsp://host:port/rtsp_tunnel?…` URL
        // that works with clients which strip in-URL creds (BlueIris,
        // Forum #84538 posts 13–18). VLC / FFmpeg also keep working — the
        // proxy detects whether the client supplies its own Authorization
        // header and only injects when needed.
        const dur = session.maxSessionDuration > 0 ? session.maxSessionDuration : 3600;
        return `${proxy.localRtspUrl}?inst=${instance}&enableaudio=1&fmtp=1&maxSessionDuration=${dur}`;
    }

    /**
     * Replace `user:password@` with `***:***@` for log lines.
     *
     * @param url
     */
    private _maskCreds(url: string): string {
        return url.replace(/(rtsp:\/\/)([^@/]+)@/, "$1***:***@");
    }

    // ── PKCE browser-login helpers ──────────────────────────────────────────

    /**
     * Generate (or reuse) a PKCE pair, build the Bosch auth URL, and log it.
     *
     * The verifier is stored in info.pkce_verifier so it survives restarts —
     * regenerated only after a successful code exchange or explicit reset.
     * This prevents "stale verifier" errors when the user copies the URL from
     * one adapter start and pastes after a second restart.
     */
    private async showLoginUrl(): Promise<void> {
        // Check if we already have a stored verifier (reuse across restarts)
        const existingVerifier = (await this.getStateAsync("info.pkce_verifier"))?.val as
            | string
            | undefined;
        let verifier: string;
        let challenge: string;
        let state: string;

        if (existingVerifier && existingVerifier.length > 10) {
            // Reuse stored verifier — derive challenge from it
            const { createHash, randomBytes } = await import("node:crypto");
            verifier = existingVerifier;
            challenge = createHash("sha256").update(verifier).digest("base64url");
            const existingState = (await this.getStateAsync("info.pkce_state"))?.val as
                | string
                | undefined;
            state =
                existingState && existingState.length > 4
                    ? existingState
                    : randomBytes(16).toString("base64url");
        } else {
            // Generate a fresh PKCE pair
            const { randomBytes } = await import("node:crypto");
            const pair = generatePkcePair();
            verifier = pair.verifier;
            challenge = pair.challenge;
            state = randomBytes(16).toString("base64url");
            await this.setStateAsync("info.pkce_verifier", verifier, true);
            await this.setStateAsync("info.pkce_state", state, true);
        }

        const authUrl = buildAuthUrl(challenge, state);

        // v0.5.4: publish URL as a state so the Admin UI can render a clickable
        // link. Survives adapter restarts (PKCE verifier is also persisted) so
        // the user doesn't have to time the login between two restart cycles.
        await this.setStateAsync("info.login_url", authUrl, true);
        await this.setStateAsync("info.connection_status", "awaiting_login", true);

        this.log.info("Login required. Open this URL in your browser and log in to Bosch:");
        this.log.info(authUrl);
        this.log.info(
            "After Bosch redirects you, copy the full redirect URL " +
                "(https://www.bosch.com/boschcam?code=...&state=...) " +
                "and paste it into the 'redirect_url' field in Admin UI, then save.",
        );
    }

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
    private async handleRedirectPaste(url: string): Promise<TokenResult> {
        const code = extractCode(url);
        if (!code) {
            throw new Error(
                "No 'code' parameter found in pasted URL. " +
                    "Make sure to copy the full URL from the browser address bar after Bosch redirects you.",
            );
        }

        const verifier = (await this.getStateAsync("info.pkce_verifier"))?.val as
            | string
            | undefined;
        if (!verifier || verifier.length < 10) {
            throw new Error(
                "No PKCE verifier stored. " +
                    "Please restart the adapter first (without a redirect_url) to generate a login URL, " +
                    "then open that URL in your browser before pasting the redirect URL.",
            );
        }

        const tokens = await exchangeCode(this._httpClient, code, verifier);
        if (!tokens) {
            throw new Error(
                "Token exchange returned null (transient network error). " +
                    "Please try again — paste the same redirect URL or generate a new login URL.",
            );
        }

        await this.saveTokens(tokens);

        // Clear paste field so it is not re-used on the next adapter restart
        try {
            await this.extendForeignObjectAsync(`system.adapter.${this.namespace}`, {
                native: { redirect_url: "" } as Partial<ioBroker.AdapterConfig>,
            });
        } catch {
            // Non-fatal — log at debug level; the code has been consumed anyway
            this.log.debug("Could not clear redirect_url in adapter config — non-fatal");
        }

        // Clear stored PKCE pair (verifier consumed — regenerate fresh on next login)
        await this.setStateAsync("info.pkce_verifier", "", true);
        await this.setStateAsync("info.pkce_state", "", true);
        // v0.5.4: hide the Admin-UI login link once login succeeded
        await this.setStateAsync("info.login_url", "", true);

        this.log.info("Login successful — tokens stored. Adapter is now connected.");
        return tokens;
    }

    // ── Lifecycle ───────────────────────────────────────────────────────────

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
    private async onReady(): Promise<void> {
        this.log.info("Bosch Smart Home Camera adapter starting…");

        // Ensure object tree for info/token states
        await this.ensureInfoObjects();
        await this.setStateAsync("info.connection", false, true);

        // ── Step 1: Obtain tokens (PKCE browser flow) ──────────────────────
        let tokens: TokenResult;
        const stored = await this.loadStoredTokens();

        if (stored) {
            this.log.info("Valid tokens found in state storage — skipping login");
            this._currentAccessToken = stored.accessToken;
            this._currentRefreshToken = stored.refreshToken;
            // Synthesise a minimal TokenResult so we can start the refresh loop
            tokens = {
                access_token: stored.accessToken,
                refresh_token: stored.refreshToken,
                expires_in: Math.max(1, Math.floor((stored.expiresAt - Date.now()) / 1000)),
                refresh_expires_in: 0,
                token_type: "Bearer",
                scope: "",
            };
        } else {
            // No valid access token. Before falling back to PKCE re-login try to
            // mint a fresh access_token from the stored refresh_token — the
            // common case after the adapter has been stopped longer than the
            // 3600 s access-token lifetime. Without this step a 1 h restart
            // pause would force the user back through the browser-login flow
            // even though the refresh_token (offline_access, ~30 d) is still
            // valid.
            const rtState = await this.getStateAsync("info.refresh_token");
            const storedRefreshToken = typeof rtState?.val === "string" ? rtState.val : "";
            let refreshed: TokenResult | null = null;
            if (storedRefreshToken) {
                try {
                    refreshed = await refreshAccessToken(this._httpClient, storedRefreshToken);
                } catch (err: unknown) {
                    const msg = err instanceof Error ? err.message : String(err);
                    this.log.warn(
                        `Refresh token exchange failed (${msg}) — falling back to browser login`,
                    );
                }
            }

            if (refreshed) {
                this.log.info(
                    "Stored access token expired — refreshed silently via offline refresh_token",
                );
                await this.saveTokens(refreshed);
                tokens = refreshed;
            } else {
                // Refresh either absent or rejected — user must redo PKCE login
                const pastedUrl = this.config.redirect_url ?? "";

                if (pastedUrl && pastedUrl.includes("code=")) {
                    // Step 2: user pasted callback URL — extract code, exchange for tokens
                    try {
                        tokens = await this.handleRedirectPaste(pastedUrl);
                    } catch (err: unknown) {
                        const msg = err instanceof Error ? err.message : String(err);
                        this.log.error(`Login failed: ${msg}`);
                        // v0.5.4: do NOT terminate — that produces the "kaputt"
                        // restart-loop the forum complained about (Forum #84538).
                        // Instead: clear the stale paste, drop the stale PKCE
                        // pair, regenerate a fresh login URL into info.login_url
                        // so the Admin UI button works, and stay alive waiting
                        // for the next paste.
                        try {
                            await this.extendForeignObjectAsync(
                                `system.adapter.${this.namespace}`,
                                {
                                    native: {
                                        redirect_url: "",
                                    } as Partial<ioBroker.AdapterConfig>,
                                },
                            );
                        } catch {
                            // Non-fatal — the user can clear redirect_url manually
                            this.log.debug("Could not auto-clear stale redirect_url — non-fatal");
                        }
                        await this.setStateAsync("info.pkce_verifier", "", true);
                        await this.setStateAsync("info.pkce_state", "", true);
                        await this.setStateAsync("info.connection", false, true);
                        await this.setStateAsync("info.connection_status", "auth_error", true);
                        await this.showLoginUrl();
                        this.log.info(
                            "Stay-alive in awaiting-login mode — open info.login_url or the 'Open Bosch Login' button to retry.",
                        );
                        return;
                    }
                } else {
                    // Step 1: no tokens, no pasted URL — generate PKCE pair and show login URL
                    await this.showLoginUrl();
                    // Stay alive in "waiting for setup" mode — user needs to paste URL
                    await this.setStateAsync("info.connection", false, true);
                    return;
                }
            }
        }

        // ── Step 2: Discover cameras ───────────────────────────────────────
        let cameras: BoschCamera[];
        try {
            cameras = await fetchCameras(this._httpClient, tokens.access_token);
            this.log.info(`Found ${cameras.length} camera(s)`);
        } catch (err: unknown) {
            if (err instanceof UnauthorizedError) {
                // Token rejected despite being fresh — refresh and retry once
                this.log.warn(
                    "Camera discovery returned 401 — attempting token refresh before retry",
                );
                try {
                    const refreshed = await refreshAccessToken(
                        this._httpClient,
                        tokens.refresh_token,
                    );
                    if (!refreshed) {
                        throw new Error("refresh returned null");
                    }
                    await this.saveTokens(refreshed);
                    cameras = await fetchCameras(this._httpClient, refreshed.access_token);
                    tokens = refreshed;
                } catch (retryErr: unknown) {
                    const msg = retryErr instanceof Error ? retryErr.message : String(retryErr);
                    this.log.error(`Camera discovery failed after token refresh: ${msg}`);
                    await this.setStateAsync("info.connection", false, true);
                    return;
                }
            } else {
                const msg = err instanceof Error ? err.message : String(err);
                this.log.error(`Camera discovery failed: ${msg}`);
                await this.setStateAsync("info.connection", false, true);
                return;
            }
        }

        // ── Step 3: Create state tree ──────────────────────────────────────
        await this.ensureCameraObjects(cameras);

        // Populate in-memory camera cache (used by handlers for Gen1/Gen2 dispatch)
        this._cameras.clear();
        for (const cam of cameras) {
            this._cameras.set(cam.id, cam);
        }

        // Hydrate runtime preference maps from persisted states so user-set
        // values survive adapter restarts (states themselves are ioBroker-persisted,
        // but the in-memory shadow maps are reset on every onReady).
        for (const cam of cameras) {
            const qState = await this.getStateAsync(`cameras.${cam.id}.stream_quality`);
            const q = typeof qState?.val === "string" ? qState.val : "high";
            this._streamQuality.set(cam.id, q === "low" ? "low" : "high");
        }

        // Subscribe to all camera states so onStateChange receives user writes
        await this.subscribeStatesAsync("cameras.*");

        // ── Step 4: Mark connected + arm refresh loop ──────────────────────
        await this.upsertState("info.connection", true);
        await this.setStateAsync("info.connection_status", "connected", true);
        this.scheduleTokenRefresh(tokens.expires_in * 1000);

        // ── Step 4b: Auto-snapshot per camera to flip `online` from default ─
        // ensureCameraObjects() seeds `online=false` (list endpoint lacks the
        // field). Fire one snapshot per camera so markCameraReachability() can
        // flip it to the real state. Fire-and-forget — failure is logged at
        // debug, never blocks adapter start.
        for (const cam of cameras) {
            void this.handleSnapshotTrigger(cam.id).catch((err: unknown) => {
                const msg = err instanceof Error ? err.message : String(err);
                this.log.debug(`Startup snapshot for ${cam.id.slice(0, 8)} failed: ${msg}`);
            });
        }

        // ── Step 5: FCM push listener (real implementation v0.3.0) ──────────
        this._fcmListener = new FcmListener(this._httpClient, tokens.access_token);

        // Silent push wake-up — Bosch sends no payload; fetch events from API
        this._fcmListener.on("push", () => {
            void this.fetchAndProcessEvents();
        });

        // Typed event fallback — when push contains explicit event-type data
        this._fcmListener.on("motion", (ev: FcmEventPayload) => {
            void this.onFcmEvent(ev);
        });
        this._fcmListener.on("audio_alarm", (ev: FcmEventPayload) => {
            void this.onFcmEvent(ev);
        });
        this._fcmListener.on("person", (ev: FcmEventPayload) => {
            void this.onFcmEvent(ev);
        });

        // Registration success — log token prefix + mark healthy
        this._fcmListener.on("registered", (creds: { fcmToken: string }) => {
            this.log.info(`FCM registered: ${creds.fcmToken.substring(0, 12)}...`);
            void this.setStateAsync("info.fcm_active", "healthy", true);
        });

        // Per-mode failure diagnostic — emitted by FcmListener._tryStart on every
        // mode that fails to register. Without this log the user sees only the
        // generic "both iOS and Android failed" message and can't diagnose the
        // real cause (network, CBS auth, @aracna/fcm bug, ...).
        this._fcmListener.on("mode-failed", (info: { mode: "ios" | "android"; error: Error }) => {
            this.log.warn(`FCM ${info.mode} registration failed: ${info.error.message}`);
            if (info.error.stack) {
                this.log.debug(`FCM ${info.mode} stack: ${info.error.stack}`);
            }
        });

        // Error events from FCM internals
        this._fcmListener.on("error", (err: Error) => {
            this.log.error(`FCM error: ${err.message}`);
            void this.setStateAsync("info.fcm_active", "error", true);
        });

        // MTalk socket closed — adapter still usable via polling
        this._fcmListener.on("disconnect", () => {
            this.log.warn("FCM disconnected — adapter continues polling");
            void this.setStateAsync("info.fcm_active", "disconnected", true);
        });

        try {
            await this._fcmListener.start();
            await this.setStateAsync("info.fcm_active", "healthy", true);
            this.log.info("FCM push listener started");
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            if (err instanceof FcmCbsRegistrationError) {
                this.log.error(`FCM CBS registration failed (auth/token issue): ${msg}`);
                await this.setStateAsync("info.fcm_active", "error", true);
            } else {
                // Both iOS and Android registration failed. Fall back to polling
                // (mirrors HA's `fcm_push_mode=polling` default-fallback) — adapter
                // stays usable; events arrive via the polling timer every 30 s.
                this.log.warn(
                    `FCM push unavailable (${msg}) — falling back to event polling every ${
                        BoschSmartHomeCamera.EVENT_POLL_INTERVAL_MS / 1000
                    }s`,
                );
                await this.setStateAsync("info.fcm_active", "polling", true);
                this._startEventPolling();
            }
            // Don't crash — adapter still usable without push (polling fallback)
        }

        // ── Step 6: Periodic camera-state poll (privacy + future fields) ────
        // Even with FCM push healthy we need this — Bosch never pushes a
        // privacy-toggle event, so app-side privacy changes only surface via
        // the next GET /v11/video_inputs. Forum #84538.
        this._startStatePolling();

        this.log.info(`Bosch Smart Home Camera adapter ready — ${cameras.length} camera(s) active`);
    }

    /**
     * Periodic refetch of `/v11/video_inputs` to mirror app-side state changes
     * (privacy, in the future also name / firmware) into ioBroker DPs.
     *
     * Designed to be cheap — single GET, ~1–2 kB JSON per call, 30 s cadence.
     * Idempotent: re-calling while a timer is already armed is a no-op.
     * Stops itself on token expiry; the token-refresh loop will re-arm.
     */
    private _startStatePolling(): void {
        if (this._statePollTimer) {
            return;
        }
        const timer = setInterval(() => {
            void this._pollCameraStateOnce().catch((err: unknown) => {
                const msg = err instanceof Error ? err.message : String(err);
                this.log.debug(`Camera state poll tick failed: ${msg}`);
            });
        }, BoschSmartHomeCamera.STATE_POLL_INTERVAL_MS);
        timer.unref();
        this._statePollTimer = timer;
    }

    /**
     * Single tick of the state poll: GET /v11/video_inputs, sync per-camera
     * fields that exist in that response back to DPs (currently just
     * privacy_enabled; light fields live on /lighting and aren't polled).
     */
    private async _pollCameraStateOnce(): Promise<void> {
        const token = this._currentAccessToken;
        if (!token) {
            // Token refresh in flight — skip; next tick will retry
            return;
        }
        let cameras: BoschCamera[];
        try {
            cameras = await fetchCameras(this._httpClient, token);
        } catch (err: unknown) {
            if (err instanceof UnauthorizedError) {
                // Let the refresh loop handle it — don't fight here
                this.log.debug("State poll: 401 — token refresh will recover");
                return;
            }
            throw err;
        }
        for (const cam of cameras) {
            // Refresh the in-memory metadata cache too (so generation/name stays
            // current after a Bosch-app rename)
            this._cameras.set(cam.id, cam);

            if (cam.privacyMode !== undefined) {
                const desired = cam.privacyMode === "ON";
                // Only write when changed — upsertState already dedupes, but a
                // log line per camera every 30 s would be noisy.
                const current = await this.getStateAsync(`cameras.${cam.id}.privacy_enabled`);
                if (current?.val !== desired) {
                    await this.upsertState(`cameras.${cam.id}.privacy_enabled`, desired);
                    this.log.debug(
                        `State poll: ${cam.id.slice(0, 8)} privacy ` +
                            `${current?.val ? "ON" : "OFF"} → ${desired ? "ON" : "OFF"} (from cloud)`,
                    );
                }
            }

            // ── Gen2 lighting/switch — seed cache + sync wallwasher DPs ────────
            // /lighting/switch is a separate endpoint (not in /v11/video_inputs),
            // so we fetch it per-camera. Only Gen2 cams with featureSupport.light
            // get this path — Gen1 has no RGB hardware.
            if (cam.generation >= 2 && cam.featureLight === true) {
                const ls = await fetchLightingState(this._httpClient, token, cam.id);
                if (ls) {
                    this._lightingCache.set(cam.id, ls);
                    // Mirror wallwasher (top+bottom LED) into DPs. Use the
                    // brighter of the two groups as the displayed brightness;
                    // colour follows the top LED (they're driven together by
                    // wallwasher writes anyway).
                    const top = ls.topLedLightSettings;
                    const bot = ls.bottomLedLightSettings;
                    const brightness = Math.max(top.brightness, bot.brightness);
                    const color = top.color ?? bot.color ?? "";

                    const curBr = await this.getStateAsync(
                        `cameras.${cam.id}.wallwasher_brightness`,
                    );
                    if (curBr?.val !== brightness) {
                        await this.upsertState(
                            `cameras.${cam.id}.wallwasher_brightness`,
                            brightness,
                        );
                    }
                    const curCol = await this.getStateAsync(`cameras.${cam.id}.wallwasher_color`);
                    if (curCol?.val !== color) {
                        await this.upsertState(`cameras.${cam.id}.wallwasher_color`, color);
                    }
                }
            }
        }
    }

    /**
     * Called whenever a subscribed state changes.
     * Only acts on ack=false states (user commands, not adapter-reported values).
     * Routes writes to the appropriate per-camera handler.
     *
     * @param id
     * @param state
     */
    private async onStateChange(
        id: string,
        state: ioBroker.State | null | undefined,
    ): Promise<void> {
        if (!state || state.ack) {
            return;
        } // ignore null deletions + already-ack'd values

        // id format: <namespace>.cameras.<camId>.<stateName>
        // Strip namespace prefix to get the relative id
        const ns = `${this.namespace}.`;
        const relId = id.startsWith(ns) ? id.slice(ns.length) : id;
        const idParts = relId.split(".");

        if (idParts[0] !== "cameras" || idParts.length < 3) {
            return;
        }

        const camId = idParts[1];
        const stateName = idParts.slice(2).join(".");

        this.log.debug(`State change: ${id} = ${state.val} (from user)`);

        try {
            switch (stateName) {
                case "privacy_enabled": {
                    const enabled = Boolean(state.val);
                    await this.handlePrivacyToggle(camId, enabled);
                    // Capture a fresh snapshot only when leaving privacy (live view is hidden while ON).
                    // Fire-and-forget — snapshot fetch can take a few seconds and must not block the ack path.
                    if (!enabled) {
                        void this.handleSnapshotTrigger(camId).catch((err: unknown) => {
                            const msg = err instanceof Error ? err.message : String(err);
                            this.log.debug(
                                `Auto-snapshot after privacy off failed for ${camId}: ${msg}`,
                            );
                        });
                    }
                    break;
                }
                case "light_enabled":
                    await this.handleLightToggle(camId, Boolean(state.val));
                    // Refresh snapshot so the dashboard reflects the new lighting.
                    void this.handleSnapshotTrigger(camId).catch((err: unknown) => {
                        const msg = err instanceof Error ? err.message : String(err);
                        this.log.debug(
                            `Auto-snapshot after light toggle failed for ${camId}: ${msg}`,
                        );
                    });
                    break;
                case "front_light_enabled":
                    await this.handleFrontLightToggle(camId, Boolean(state.val));
                    void this.handleSnapshotTrigger(camId).catch((err: unknown) => {
                        const msg = err instanceof Error ? err.message : String(err);
                        this.log.debug(
                            `Auto-snapshot after front_light toggle failed for ${camId}: ${msg}`,
                        );
                    });
                    break;
                case "wallwasher_enabled":
                    await this.handleWallwasherToggle(camId, Boolean(state.val));
                    void this.handleSnapshotTrigger(camId).catch((err: unknown) => {
                        const msg = err instanceof Error ? err.message : String(err);
                        this.log.debug(
                            `Auto-snapshot after wallwasher toggle failed for ${camId}: ${msg}`,
                        );
                    });
                    break;
                case "image_rotation_180":
                    await this.handleImageRotationToggle(camId, Boolean(state.val));
                    break;
                case "snapshot_trigger":
                    if (state.val) {
                        await this.handleSnapshotTrigger(camId);
                        // Reset trigger button to false (no longer "pending")
                        await this.setStateAsync(id, false, true);
                    }
                    return; // skip generic ack below
                case "motion_trigger":
                    if (state.val) {
                        // Read the sibling event-type state (default "motion")
                        const etState = await this.getStateAsync(
                            `cameras.${camId}.motion_trigger_event_type`,
                        );
                        const validTypes = new Set(["motion", "person", "audio_alarm"]);
                        const rawEt = typeof etState?.val === "string" ? etState.val : "motion";
                        const eventType = validTypes.has(rawEt) ? rawEt : "motion";
                        await this.triggerSyntheticMotion(camId, eventType);
                        // Reset trigger button to false
                        await this.setStateAsync(id, false, true);
                    }
                    return; // skip generic ack below
                case "stream_quality":
                    await this.handleStreamQualityChange(camId, String(state.val));
                    break;
                case "livestream_enabled":
                    await this.handleLivestreamToggle(camId, Boolean(state.val));
                    break;
                case "siren_active":
                    await this.handleSirenToggle(camId, Boolean(state.val));
                    break;
                case "wallwasher_color":
                    await this.handleWallwasherUpdate(camId, {
                        color: typeof state.val === "string" ? state.val : "",
                    });
                    break;
                case "wallwasher_brightness":
                    await this.handleWallwasherUpdate(camId, {
                        brightness:
                            typeof state.val === "number"
                                ? state.val
                                : parseInt(String(state.val), 10),
                    });
                    break;
                default:
                    return; // unknown writable state — no-op
            }
            // On success: ack the state with the value the user requested
            await this.setStateAsync(id, state.val, true);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            this.log.error(`Failed to handle ${stateName} for ${camId}: ${msg}`);
            // Don't ack — leave state in user-set (ack=false) so it's visible as "pending failed"
        }
    }

    // ── FCM event handler ───────────────────────────────────────────────────

    /**
     * Handle an FCM motion/person/audio_alarm push event.
     * Writes per-camera last_motion_at + last_motion_event_type, flips
     * motion_active=true (with auto-clear timer), and — when
     * `auto_snapshot_on_motion` is on — fetches a fresh JPEG and publishes
     * it as base64 in last_event_image so Telegram / Signal / Matrix
     * automations can push it directly.
     *
     * @param ev
     */
    private async onFcmEvent(ev: FcmEventPayload): Promise<void> {
        const prefix = `cameras.${ev.cameraId}`;
        await this.setStateAsync(
            `${prefix}.last_motion_at`,
            BoschSmartHomeCamera.normaliseBoschTimestamp(ev.timestamp),
            true,
        );
        await this.setStateAsync(`${prefix}.last_motion_event_type`, ev.eventType, true);
        this.log.info(
            `FCM event [${ev.eventType}] for camera ${ev.cameraId.slice(0, 8)} at ${ev.timestamp}`,
        );
        await this._onMotionFired(ev.cameraId);
    }

    /**
     * v0.5.3: shared post-event side effects, called by both real FCM
     * events and synthetic motion triggers. Flips motion_active=true with
     * a 90 s auto-clear, and — when auto_snapshot_on_motion is enabled —
     * fires a fresh snapshot in the background (reuses the warm session
     * via the v0.5.3 keep-alive optimization for rapid bursts).
     *
     * @param camId Camera UUID
     */
    private async _onMotionFired(camId: string): Promise<void> {
        // Edge-trigger boolean: set true, arm 90 s auto-clear
        await this.setStateAsync(`cameras.${camId}.motion_active`, true, true);
        const previous = this._motionActiveTimers.get(camId);
        if (previous) {
            clearTimeout(previous);
        }
        const clearTimer = setTimeout(() => {
            this._motionActiveTimers.delete(camId);
            void this.setStateAsync(`cameras.${camId}.motion_active`, false, true).catch(
                (err: unknown) => {
                    this.log.debug(
                        `motion_active auto-clear for ${camId.slice(0, 8)} threw: ` +
                            `${err instanceof Error ? err.message : String(err)}`,
                    );
                },
            );
        }, BoschSmartHomeCamera.MOTION_ACTIVE_WINDOW_MS);
        clearTimer.unref();
        this._motionActiveTimers.set(camId, clearTimer);

        // Optional: auto-snapshot — default true, opt-out via adapter config
        // (the field is `undefined` on legacy installs that never saw the
        // option, so treat `undefined` like `true`).
        const optedOut = this.config.auto_snapshot_on_motion === false;
        if (!optedOut) {
            void this.handleSnapshotTrigger(camId, { asMotionEvent: true }).catch(
                (err: unknown) => {
                    this.log.debug(
                        `Auto-snapshot on motion for ${camId.slice(0, 8)} failed: ` +
                            `${err instanceof Error ? err.message : String(err)}`,
                    );
                },
            );
        }
    }

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
    private async triggerSyntheticMotion(camId: string, eventType: string): Promise<void> {
        const ts = new Date().toISOString();
        const prefix = `cameras.${camId}`;
        await this.setStateAsync(`${prefix}.last_motion_at`, ts, true);
        await this.setStateAsync(`${prefix}.last_motion_event_type`, eventType, true);
        this.log.info(`Synthetic ${eventType} trigger for camera ${camId.slice(0, 8)}`);
        // v0.5.3: same side-effects as a real FCM event so synthetic
        // triggers (Philips Hue motion in the driveway, …) also flip
        // motion_active and refresh last_event_image.
        await this._onMotionFired(camId);
    }

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
    private async handleSirenToggle(camId: string, enabled: boolean): Promise<void> {
        const cam = this._cameras.get(camId);
        if (!cam || cam.generation < 2) {
            this.log.warn(`Siren request for ${camId.slice(0, 8)} ignored — not a Gen2 camera`);
            throw new Error("siren not supported on this camera");
        }
        if (!this._currentAccessToken) {
            throw new Error("no access token — adapter not ready");
        }
        const ok = await setPanicAlarm(this._httpClient, this._currentAccessToken, camId, enabled);
        if (!ok) {
            throw new Error(`PUT /panic_alarm returned non-success for ${camId.slice(0, 8)}`);
        }
        this._sirenState.set(camId, enabled);
        this.log.info(`Siren ${enabled ? "TRIGGERED" : "stopped"} for camera ${camId.slice(0, 8)}`);
    }

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
    private async handleWallwasherUpdate(
        camId: string,
        delta: { brightness?: number; color?: string },
    ): Promise<void> {
        const cam = this._cameras.get(camId);
        if (!cam || cam.generation < 2 || cam.featureLight !== true) {
            this.log.warn(
                `Wallwasher request for ${camId.slice(0, 8)} ignored — Gen2 lighting not supported`,
            );
            throw new Error("wallwasher not supported on this camera");
        }
        if (!this._currentAccessToken) {
            throw new Error("no access token — adapter not ready");
        }
        const current = this._lightingCache.get(camId) ?? DEFAULT_LIGHTING_STATE;
        // Translate "" → null (white-balance), undefined → keep current
        let colorArg: string | null | undefined;
        if (delta.color === undefined) {
            colorArg = undefined;
        } else if (delta.color === "") {
            colorArg = null;
        } else {
            colorArg = delta.color;
        }
        let brightnessArg: number | undefined;
        if (delta.brightness !== undefined) {
            brightnessArg = Number.isFinite(delta.brightness) ? delta.brightness : 0;
        }
        const next = buildWallwasherUpdate(current, brightnessArg, colorArg);
        const result = await putLightingState(
            this._httpClient,
            this._currentAccessToken,
            camId,
            next,
        );
        if (!result) {
            throw new Error(`PUT /lighting/switch returned non-success for ${camId.slice(0, 8)}`);
        }
        this._lightingCache.set(camId, result);
        this.log.info(
            `Wallwasher update for camera ${camId.slice(0, 8)}: ` +
                `top brightness=${result.topLedLightSettings.brightness} ` +
                `color=${result.topLedLightSettings.color ?? `wb=${result.topLedLightSettings.whiteBalance}`}`,
        );
    }

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
    private async handleStreamQualityChange(camId: string, quality: string): Promise<void> {
        const normalised: "high" | "low" = quality === "low" ? "low" : "high";
        const previous = this._streamQuality.get(camId) ?? "high";
        if (previous === normalised) {
            return; // no-op
        }
        this._streamQuality.set(camId, normalised);
        this.log.info(
            `Stream quality for ${camId.slice(0, 8)}: ${previous} → ${normalised} ` +
                `(closing session so next stream request re-opens with new flag)`,
        );

        // Close existing session so the next ensureLiveSession() picks up the
        // new highQualityVideo flag. Best-effort — proxy stays serving the
        // existing stream until the next renewal cycle.
        if (this._liveSessions.has(camId)) {
            if (this._currentAccessToken) {
                try {
                    await closeLiveSession(this._httpClient, this._currentAccessToken, camId);
                } catch (err) {
                    // Best-effort — Bosch may already have closed it
                    this.log.debug(
                        `closeLiveSession during quality change for ${camId.slice(0, 8)}: ` +
                            `${err instanceof Error ? err.message : String(err)}`,
                    );
                }
            }
            this._liveSessions.delete(camId);
        }

        // Stop the watchdog too — the next ensureLiveSession() rebuilds it
        // with the renewed maxSessionDuration for the new session.
        const watchdog = this._sessionWatchdogs.get(camId);
        if (watchdog) {
            watchdog.stop();
            this._sessionWatchdogs.delete(camId);
        }
    }

    /**
     * Arm (or reset) the post-snapshot idle teardown timer for one camera.
     * Called from `handleSnapshotTrigger` in `finally` when livestream is
     * OFF. Each new snapshot resets the timer so a Card / automation
     * burst keeps the Bosch session warm for `SNAPSHOT_SESSION_IDLE_MS`
     * (default 60 s) — only the first snap pays the `PUT /connection`
     * cost, subsequent snaps reuse the cached session.
     *
     * @param camId  Camera UUID
     */
    private _armSnapshotIdleTeardown(camId: string): void {
        // Cancel any previous pending teardown so the window slides on every snap
        const previous = this._snapshotIdleTimers.get(camId);
        if (previous) {
            clearTimeout(previous);
        }
        const timer = setTimeout(() => {
            this._snapshotIdleTimers.delete(camId);
            void this._teardownStream(camId).catch((err: unknown) => {
                this.log.debug(
                    `Idle teardown for ${camId.slice(0, 8)} threw: ` +
                        `${err instanceof Error ? err.message : String(err)}`,
                );
            });
        }, BoschSmartHomeCamera.SNAPSHOT_SESSION_IDLE_MS);
        // unref() so a dangling timer doesn't keep the Node event loop alive
        // — important for mocha. Production: ioBroker holds the loop open.
        timer.unref();
        this._snapshotIdleTimers.set(camId, timer);
    }

    /** Cancel the pending idle-teardown timer for one camera, if any. */
    private _cancelSnapshotIdleTeardown(camId: string): void {
        const timer = this._snapshotIdleTimers.get(camId);
        if (timer) {
            clearTimeout(timer);
            this._snapshotIdleTimers.delete(camId);
        }
    }

    /**
     * Tear down everything that keeps a livestream alive for one camera:
     * session watchdog, TLS proxy, Bosch live session (DELETE /connection),
     * and the public stream_url DP. Used by:
     *   - the livestream toggle (user sets livestream_enabled=false)
     *   - the post-snapshot idle timer when livestream is OFF (auto-cleanup
     *     so a Card burst doesn't accidentally start 24/7 streaming, but
     *     consecutive snaps within the idle window reuse the warm session).
     * Best-effort throughout — Bosch may have already closed the session
     * server-side after a transient network drop.
     *
     * @param camId  Camera UUID
     */
    private async _teardownStream(camId: string): Promise<void> {
        // v0.5.3: cancel any pending idle-teardown timer first so this
        // explicit teardown can't race with a delayed timer firing later
        // and trying to close an already-closed session.
        this._cancelSnapshotIdleTeardown(camId);

        // Stop watchdog FIRST so it doesn't fire a renewal after we close
        const watchdog = this._sessionWatchdogs.get(camId);
        if (watchdog) {
            watchdog.stop();
            this._sessionWatchdogs.delete(camId);
        }

        // Stop the TLS proxy (frees the bound port)
        const proxy = this._tlsProxies.get(camId);
        if (proxy) {
            try {
                await proxy.stop();
            } catch (err) {
                this.log.debug(
                    `_teardownStream: proxy.stop() for ${camId.slice(0, 8)} threw: ` +
                        `${err instanceof Error ? err.message : String(err)}`,
                );
            }
            this._tlsProxies.delete(camId);
        }
        this._sessionRemote.delete(camId);

        // Close the Bosch live session — frees the LOCAL session slot
        if (this._liveSessions.has(camId) && this._currentAccessToken) {
            try {
                await closeLiveSession(this._httpClient, this._currentAccessToken, camId);
            } catch (err) {
                this.log.debug(
                    `_teardownStream: closeLiveSession for ${camId.slice(0, 8)} threw: ` +
                        `${err instanceof Error ? err.message : String(err)}`,
                );
            }
        }
        this._liveSessions.delete(camId);

        // Clear the public stream_url DPs (main + sub) so consumers see "no stream"
        await this.upsertState(`cameras.${camId}.stream_url`, "");
        await this.upsertState(`cameras.${camId}.stream_url_sub`, "");
    }

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
    private async handleLivestreamToggle(camId: string, enabled: boolean): Promise<void> {
        const previous = this._livestreamEnabled.get(camId) === true;
        this._livestreamEnabled.set(camId, enabled);
        if (previous === enabled) {
            return; // no-op
        }
        if (enabled) {
            // v0.5.3: cancel any pending snapshot idle teardown — once
            // livestream is on, the session must stay alive indefinitely
            // (watchdog handles natural renewal). Without this cancel, a
            // snapshot triggered just before the user enabled livestream
            // could fire the idle timer 60 s later and tear down the
            // freshly-opened stream.
            this._cancelSnapshotIdleTeardown(camId);
            // Open Bosch session + spawn TLS proxy + arm watchdog + populate stream_url
            await this.ensureLiveSession(camId);
            this.log.info(`Livestream STARTED for camera ${camId.slice(0, 8)}`);
        } else {
            await this._teardownStream(camId);
            this.log.info(`Livestream STOPPED for camera ${camId.slice(0, 8)}`);
        }
    }

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
    private async fetchAndProcessEvents(): Promise<void> {
        if (!this._currentAccessToken) {
            return;
        }
        const token = this._currentAccessToken;
        const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };

        for (const [camId] of this._cameras) {
            try {
                const url = `https://residential.cbs.boschsecurity.com/v11/events?videoInputId=${camId}&limit=5`;
                const resp = await this._httpClient.get(url, {
                    headers,
                    validateStatus: () => true,
                });
                if (resp.status !== 200 || !Array.isArray(resp.data) || resp.data.length === 0) {
                    continue;
                }

                const events = resp.data as Array<Record<string, unknown>>;
                const newest = events[0];
                const newestId = (newest.id ?? "") as string;
                const prevId = this._lastSeenEventId[camId] ?? "";

                // Skip if we've already processed this event (dedup)
                if (!newestId || newestId === prevId) {
                    continue;
                }
                this._lastSeenEventId[camId] = newestId;

                // Normalise event type — mirrors HA fcm.py PERSON upgrade logic
                const rawType = ((newest.eventType ?? "") as string).toUpperCase();
                const tags = (newest.eventTags ?? []) as string[];
                let eventType: string;
                if (rawType === "MOVEMENT" && tags.includes("PERSON")) {
                    eventType = "person";
                } else if (rawType === "MOVEMENT") {
                    eventType = "motion";
                } else if (rawType === "AUDIO_ALARM") {
                    eventType = "audio_alarm";
                } else if (rawType === "PERSON") {
                    eventType = "person";
                } else {
                    eventType = rawType.toLowerCase() || "motion";
                }

                // Timestamp — prefer ISO string, fall back to current time
                const rawTs =
                    ((newest.timestamp ?? newest.createdAt ?? "") as string) ||
                    new Date().toISOString();
                const ts = BoschSmartHomeCamera.normaliseBoschTimestamp(rawTs);

                const prefix = `cameras.${camId}`;
                await this.setStateAsync(`${prefix}.last_motion_at`, ts, true);
                await this.setStateAsync(`${prefix}.last_motion_event_type`, eventType, true);

                this.log.info(
                    `Motion event [${eventType}] for camera ${camId.slice(0, 8)} at ${ts} (id=${newestId.slice(0, 8)})`,
                );
            } catch (err: unknown) {
                this.log.debug(
                    `fetchAndProcessEvents failed for ${camId.slice(0, 8)}: ${(err as Error).message}`,
                );
            }
        }
    }

    // ── Camera command handlers ─────────────────────────────────────────────

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
    private async handlePrivacyToggle(camId: string, enabled: boolean): Promise<void> {
        if (!this._currentAccessToken) {
            throw new Error(`Cannot set privacy for ${camId} — no access token`);
        }
        const url = `https://residential.cbs.boschsecurity.com/v11/video_inputs/${camId}/privacy`;
        const body = { privacyMode: enabled ? "ON" : "OFF", durationInSeconds: null };
        const resp = await this._httpClient.put(url, body, {
            headers: {
                Authorization: `Bearer ${this._currentAccessToken}`,
                "Content-Type": "application/json",
                Accept: "application/json",
            },
            validateStatus: () => true,
        });
        if (![200, 201, 204].includes(resp.status)) {
            throw new Error(`Cloud privacy PUT returned HTTP ${resp.status}`);
        }
        this.log.info(`Privacy mode ${enabled ? "ON" : "OFF"} set for camera ${camId.slice(0, 8)}`);
    }

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
    private async handleLightToggle(camId: string, enabled: boolean): Promise<void> {
        // Legacy combined switch — moves both lights together.
        await this._applyLightingState(camId, {
            frontLight: enabled,
            wallwasher: enabled,
        });
    }

    /**
     * v0.4.0: toggle the front spotlight only, keep wallwasher untouched.
     * Requested by ioBroker forum #84538 for dusk-sensor-driven group switching.
     *
     * @param camId
     * @param enabled
     */
    private async handleFrontLightToggle(camId: string, enabled: boolean): Promise<void> {
        const currentWallwasher = await this._readBoolState(`cameras.${camId}.wallwasher_enabled`);
        await this._applyLightingState(camId, {
            frontLight: enabled,
            wallwasher: currentWallwasher,
        });
    }

    /**
     * v0.4.0: toggle the wallwasher (Gen1) / top-down LED strip (Gen2) only,
     * keep front spotlight untouched.
     *
     * @param camId
     * @param enabled
     */
    private async handleWallwasherToggle(camId: string, enabled: boolean): Promise<void> {
        const currentFront = await this._readBoolState(`cameras.${camId}.front_light_enabled`);
        await this._applyLightingState(camId, {
            frontLight: currentFront,
            wallwasher: enabled,
        });
    }

    /**
     * Read a boolean state with default false (treats null/undefined/non-bool as false).
     *
     * @param id
     */
    private async _readBoolState(id: string): Promise<boolean> {
        const s = await this.getStateAsync(id);
        return s?.val === true;
    }

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
    private async _applyLightingState(
        camId: string,
        state: { frontLight: boolean; wallwasher: boolean },
    ): Promise<void> {
        if (!this._currentAccessToken) {
            throw new Error(`Cannot set light for ${camId} — no access token`);
        }
        const cam = this._cameras.get(camId);
        const isGen2 = cam?.generation === 2;
        const headers = {
            Authorization: `Bearer ${this._currentAccessToken}`,
            "Content-Type": "application/json",
            Accept: "application/json",
        };

        if (isGen2) {
            const base = `https://residential.cbs.boschsecurity.com/v11/video_inputs/${camId}/lighting/switch`;
            const [r1, r2] = await Promise.all([
                this._httpClient.put(
                    `${base}/front`,
                    { enabled: state.frontLight },
                    { headers, validateStatus: () => true },
                ),
                this._httpClient.put(
                    `${base}/topdown`,
                    { enabled: state.wallwasher },
                    { headers, validateStatus: () => true },
                ),
            ]);
            const ok1 = [200, 201, 204].includes(r1.status);
            const ok2 = [200, 201, 204].includes(r2.status);
            if (!ok1 && !ok2) {
                throw new Error(
                    `Cloud light PUT Gen2 returned HTTP front=${r1.status} topdown=${r2.status}`,
                );
            }
        } else {
            const url = `https://residential.cbs.boschsecurity.com/v11/video_inputs/${camId}/lighting_override`;
            const body = {
                frontLightOn: state.frontLight,
                wallwasherOn: state.wallwasher,
                ...(state.frontLight ? { frontLightIntensity: 1.0 } : {}),
            };
            const resp = await this._httpClient.put(url, body, {
                headers,
                validateStatus: () => true,
            });
            if (![200, 201, 204].includes(resp.status)) {
                throw new Error(`Cloud light PUT Gen1 returned HTTP ${resp.status}`);
            }
        }

        // Keep all three light states in sync (front_light + wallwasher + legacy combined)
        await this.setStateAsync(`cameras.${camId}.front_light_enabled`, state.frontLight, true);
        await this.setStateAsync(`cameras.${camId}.wallwasher_enabled`, state.wallwasher, true);
        await this.setStateAsync(
            `cameras.${camId}.light_enabled`,
            state.frontLight && state.wallwasher,
            true,
        );

        this.log.info(
            `Camera light front=${state.frontLight ? "ON" : "OFF"} wallwasher=${
                state.wallwasher ? "ON" : "OFF"
            } for ${camId.slice(0, 8)} (gen${isGen2 ? 2 : 1})`,
        );
    }

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
    // Kept async to match the sibling toggle handlers (handlePrivacyToggle, handleLightToggle)
    // — the dispatcher in onStateChange awaits all of them uniformly.
    // eslint-disable-next-line @typescript-eslint/require-await
    private async handleImageRotationToggle(camId: string, rotated180: boolean): Promise<void> {
        this._imageRotation[camId] = rotated180;
        this.log.info(
            `Image rotation ${rotated180 ? "180°" : "0°"} set for camera ${camId.slice(0, 8)}`,
        );
    }

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
    private async handleSnapshotTrigger(
        camId: string,
        opts: { asMotionEvent?: boolean } = {},
    ): Promise<void> {
        const session = await this.ensureLiveSession(camId);
        const snapUrl = buildSnapshotUrl(session.proxyUrl);

        // v0.5.2: when livestream is OFF (default), a snapshot must NOT leave
        // a long-running session + proxy + watchdog behind.
        // v0.5.3: instead of tearing down immediately we arm an idle timer
        // in `finally`; back-to-back snaps within
        // SNAPSHOT_SESSION_IDLE_MS reset it and reuse the cached session.
        // After the idle window expires the timer fires _teardownStream.
        const livestreamOn = this._livestreamEnabled.get(camId) === true;

        try {
            let buf: Buffer;
            try {
                buf = await fetchSnapshot(snapUrl, session.digestUser, session.digestPassword);
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                // Only retry on "aborted" / connection-reset errors — not on auth (401)
                // or non-image content type (no point retrying those).
                const isTransient = /abort|reset|ECONNRESET|socket hang up|timeout/i.test(msg);
                if (!isTransient) {
                    await this.markCameraReachability(camId, false);
                    throw err;
                }

                this.log.debug(`Snapshot retry for ${camId.slice(0, 8)}: ${msg}`);
                await new Promise((r) => setTimeout(r, 800));
                try {
                    buf = await fetchSnapshot(snapUrl, session.digestUser, session.digestPassword);
                } catch (retryErr) {
                    await this.markCameraReachability(camId, false);
                    throw retryErr;
                }
            }

            const filePath = `cameras/${camId}/snapshot.jpg`;
            await this.writeFileAsync(this.namespace, filePath, buf);
            await this.setStateAsync(
                `cameras.${camId}.snapshot_path`,
                `/${this.namespace}/${filePath}`,
                true,
            );

            // v0.5.3: motion-event snapshots additionally publish the JPEG as
            // base64 so push integrations (Telegram, Signal, Matrix) can
            // forward the picture without reading the adapter file store.
            if (opts.asMotionEvent) {
                const b64 = `data:image/jpeg;base64,${buf.toString("base64")}`;
                await this.setStateAsync(`cameras.${camId}.last_event_image`, b64, true);
                await this.setStateAsync(
                    `cameras.${camId}.last_event_image_at`,
                    new Date().toISOString(),
                    true,
                );
            }

            await this.markCameraReachability(camId, true);
            this.log.info(`Snapshot saved for camera ${camId.slice(0, 8)}: ${buf.length} bytes`);
        } finally {
            if (!livestreamOn) {
                // v0.5.3: arm idle teardown instead of closing immediately so
                // a burst of snapshot_triggers reuses the warm session. The
                // timer is reset on every snap, so the window always extends
                // SNAPSHOT_SESSION_IDLE_MS from the *last* snap.
                this._armSnapshotIdleTeardown(camId);
            }
        }
    }

    /**
     * Start the polling fallback: re-fetch /v11/events every 30 s.
     *
     * Activated only when FCM push registration fails for both iOS and Android.
     * Mirrors HA's `fcm_push_mode=polling` behaviour — adapter stays usable, just
     * with higher motion-event latency (~30 s vs. ~2 s with push).
     *
     * Idempotent: re-calling while a timer is already armed is a no-op.
     */
    private _startEventPolling(): void {
        if (this._eventPollTimer) {
            return;
        }
        const timer = setInterval(() => {
            void this.fetchAndProcessEvents().catch((err: unknown) => {
                const msg = err instanceof Error ? err.message : String(err);
                this.log.debug(`Event polling tick failed: ${msg}`);
            });
        }, BoschSmartHomeCamera.EVENT_POLL_INTERVAL_MS);
        // unref() so the timer doesn't keep the Node event loop alive on its
        // own — important for mocha which won't exit while pending intervals
        // exist. Production: ioBroker holds the loop open via other handles, so
        // unref() has no effect on uptime.
        timer.unref();
        this._eventPollTimer = timer;
    }

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
    /**
     * v0.5.4: Bosch returns timestamps in Java's ZonedDateTime#toString format
     * — "2026-05-15T06:51:47.604+02:00[Europe/Berlin]". The trailing
     * `[zone-id]` is IETF/Java-only and breaks any standard ISO 8601 parser
     * including JavaScript's `new Date()`. Strip it so consumers can parse.
     *
     * @param raw Bosch timestamp (e.g. from /v11/events `timestamp` field).
     * @returns ISO 8601 string, or the input unchanged if no zone suffix.
     */
    private static normaliseBoschTimestamp(raw: string): string {
        if (typeof raw !== "string") {
            return raw;
        }
        return raw.replace(/\[[^\]]+\]$/, "");
    }

    private async markCameraReachability(camId: string, reachable: boolean): Promise<void> {
        if (reachable) {
            if (this._snapshotFailCount.get(camId)) {
                this._snapshotFailCount.delete(camId);
            }
            await this.setStateAsync(`cameras.${camId}.online`, true, true);
            return;
        }
        // v0.5.4: privacy_enabled=true makes the camera refuse snapshots — that is
        // a USER state, not a reachability problem. Don't count those failures
        // toward the offline threshold; without this guard, an indoor camera in
        // permanent privacy mode drifts to online=false after 3 startup probes
        // even though the Bosch cloud happily syncs its config.
        try {
            const priv = await this.getStateAsync(`cameras.${camId}.privacy_enabled`);
            if (priv?.val === true) {
                this.log.debug(
                    `Skipping reachability decrement for ${camId.slice(0, 8)} — privacy mode is ON`,
                );
                return;
            }
        } catch {
            // Fall through — if we can't read the privacy state, treat the
            // failure normally so a truly unreachable camera still flips offline.
        }
        const failures = (this._snapshotFailCount.get(camId) ?? 0) + 1;
        this._snapshotFailCount.set(camId, failures);
        if (failures >= BoschSmartHomeCamera.OFFLINE_THRESHOLD) {
            await this.setStateAsync(`cameras.${camId}.online`, false, true);
        }
    }

    /**
     * Called when the adapter is stopped.
     * Cleans up TLS proxies, FCM listener, live sessions, and the refresh timer.
     * Must always call callback() — ioBroker enforces a timeout.
     *
     * @param callback
     */
    private onUnload(callback: () => void): void {
        void (async () => {
            try {
                // Clear the refresh timer (this.clearTimeout auto-tracks via adapter-core)
                if (this._refreshTimeout) {
                    this.clearTimeout(this._refreshTimeout);
                    this._refreshTimeout = null;
                }

                // Stop event polling timer (only set when FCM fell back to polling)
                if (this._eventPollTimer) {
                    clearInterval(this._eventPollTimer);
                    this._eventPollTimer = null;
                }

                // Stop camera-state poll timer (always armed when adapter is healthy)
                if (this._statePollTimer) {
                    clearInterval(this._statePollTimer);
                    this._statePollTimer = null;
                }

                // Stop FCM listener
                if (this._fcmListener) {
                    try {
                        await this._fcmListener.stop();
                    } catch {
                        /* best-effort */
                    }
                    this._fcmListener = null;
                }

                // v0.5.3: cancel pending snapshot idle teardown timers
                // before stopping the watchdogs/proxies — otherwise a timer
                // that fires during shutdown would try to close an
                // already-closed session.
                for (const [, timer] of this._snapshotIdleTimers) {
                    clearTimeout(timer);
                }
                this._snapshotIdleTimers.clear();

                // v0.5.3: cancel motion_active auto-clear timers so they
                // don't fire after shutdown and try to write states on a
                // dead adapter.
                for (const [, timer] of this._motionActiveTimers) {
                    clearTimeout(timer);
                }
                this._motionActiveTimers.clear();

                // Stop all session watchdogs BEFORE stopping TLS proxies
                // (prevents watchdog renewal racing with cleanup)
                for (const [, watchdog] of this._sessionWatchdogs) {
                    watchdog.stop();
                }
                this._sessionWatchdogs.clear();

                // Stop all TLS proxies
                for (const [, handle] of this._tlsProxies) {
                    try {
                        await handle.stop();
                    } catch {
                        /* best-effort */
                    }
                }
                this._tlsProxies.clear();

                // Close all live sessions (best-effort — camera may be gone)
                if (this._currentAccessToken) {
                    const token = this._currentAccessToken;
                    for (const [camId] of this._liveSessions) {
                        try {
                            await closeLiveSession(this._httpClient, token, camId);
                        } catch {
                            /* best-effort */
                        }
                    }
                }
                this._liveSessions.clear();

                // Best-effort connection flag (async — may not complete if ioBroker kills us)
                void this.setStateAsync("info.connection", false, true).catch(() => undefined);
                void this.setStateAsync("info.fcm_active", "stopped", true).catch(() => undefined);

                this.log.info("Bosch Smart Home Camera adapter stopped");
            } catch {
                // swallow — we must always call callback
            } finally {
                callback();
            }
        })();
    }
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

if (require.main !== module) {
    // Called by ioBroker adapter host — export factory
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) =>
        new BoschSmartHomeCamera(options);
} else {
    // Run directly for local debugging: node build/main.js
    (() => new BoschSmartHomeCamera())();
}

// Re-export for testing
export { BoschSmartHomeCamera };
