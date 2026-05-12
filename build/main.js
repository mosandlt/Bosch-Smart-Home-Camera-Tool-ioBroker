"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.BoschSmartHomeCamera = void 0;
const utils = __importStar(require("@iobroker/adapter-core"));
require("./lib/adapter-config"); // augment ioBroker.AdapterConfig with our typed settings
const auth_1 = require("./lib/auth");
const login_1 = require("./lib/login");
const cameras_1 = require("./lib/cameras");
// ── Adapter class ─────────────────────────────────────────────────────────────
class BoschSmartHomeCamera extends utils.Adapter {
    /** setTimeout handle for the token refresh re-arm loop (ioBroker.Timeout | null). */
    _refreshTimeout = null;
    /** Current refresh_token (kept in memory to avoid repeated state reads). */
    _currentRefreshToken = null;
    /** Current access_token (kept in memory). */
    _currentAccessToken = null;
    /** Cache: skip DB write when value is unchanged (iobroker.ring upsertState pattern). */
    _stateCache = new Map();
    /** Axios instance shared across all HTTP calls. */
    _httpClient = (0, auth_1.createHttpClient)();
    constructor(options = {}) {
        super({
            ...options,
            name: "bosch-smart-home-camera",
        });
        this.on("ready", this.onReady.bind(this));
        this.on("stateChange", this.onStateChange.bind(this));
        this.on("unload", this.onUnload.bind(this));
    }
    // ── State helpers ───────────────────────────────────────────────────────
    /**
     * Write a state only if the value changed (iobroker.ring upsertState pattern).
     * Always creates the object if it doesn't exist yet, then sets ack=true.
     */
    async upsertState(id, value) {
        if (this._stateCache.get(id) === value)
            return;
        this._stateCache.set(id, value);
        await this.setStateAsync(id, value, true);
    }
    // ── Object creation ─────────────────────────────────────────────────────
    /** Ensure the info channel + connection/token states exist. */
    async ensureInfoObjects() {
        // info.connection is pre-created via instanceObjects in io-package.json,
        // but we defensively create it here too so tests pass without a full ioBroker host.
        await this.setObjectNotExistsAsync("info", {
            type: "channel",
            common: { name: "Adapter information" },
            native: {},
        });
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
    }
    /**
     * Create the cameras device + one channel per camera.
     * Uses setObjectNotExistsAsync to preserve user history config.
     */
    async ensureCameraObjects(cameras) {
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
            // Set initial values
            await this.upsertState(`${prefix}.name`, cam.name);
            await this.upsertState(`${prefix}.firmware_version`, cam.firmwareVersion);
            await this.upsertState(`${prefix}.hardware_version`, cam.hardwareVersion);
            await this.upsertState(`${prefix}.generation`, cam.generation);
            await this.upsertState(`${prefix}.online`, cam.online);
        }
    }
    // ── Token persistence ───────────────────────────────────────────────────
    /** Save tokens to ioBroker states (survives adapter restart). */
    async saveTokens(tokens) {
        const expiresAt = Date.now() + tokens.expires_in * 1000;
        this._currentAccessToken = tokens.access_token;
        this._currentRefreshToken = tokens.refresh_token;
        await this.upsertState("info.access_token", tokens.access_token);
        await this.upsertState("info.refresh_token", tokens.refresh_token);
        await this.upsertState("info.token_expires_at", expiresAt);
    }
    /**
     * Load tokens from ioBroker states (from a previous run).
     * Returns null if tokens are absent or already expired.
     */
    async loadStoredTokens() {
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
    scheduleTokenRefresh(expiresInMs) {
        // Refresh at 75% of token lifetime — leaves a safety buffer before expiry.
        const refreshIn = Math.max(60_000, expiresInMs * 0.75);
        // this.setTimeout returns ioBroker.Timeout | undefined — cast via unknown to normalise
        this._refreshTimeout = this.setTimeout(async () => {
            this._refreshTimeout = null;
            if (!this._currentRefreshToken) {
                this.log.warn("Token refresh skipped — no refresh token in memory");
                return;
            }
            try {
                const newTokens = await (0, auth_1.refreshAccessToken)(this._httpClient, this._currentRefreshToken);
                if (!newTokens) {
                    // Transient network error — retry in 5 min
                    this.log.warn("Token refresh returned null (network) — retrying in 5 min");
                    this.scheduleTokenRefresh(5 * 60_000);
                    return;
                }
                await this.saveTokens(newTokens);
                this.log.debug("Token refresh successful — next refresh in ~" + Math.round(newTokens.expires_in * 0.75 / 60) + " min");
                this.scheduleTokenRefresh(newTokens.expires_in * 1000);
            }
            catch (err) {
                if (err instanceof auth_1.RefreshTokenInvalidError) {
                    this.log.error("Refresh token invalid — please reconfigure credentials in Admin UI");
                    await this.setStateAsync("info.connection", false, true);
                    // Do NOT re-arm — user must re-configure and restart the adapter
                }
                else {
                    // AuthServerOutageError or unexpected — retry in 5 min
                    const msg = err instanceof Error ? err.message : String(err);
                    this.log.warn(`Token refresh failed: ${msg} — retrying in 5 min`);
                    this.scheduleTokenRefresh(5 * 60_000);
                }
            }
        }, refreshIn) ?? null;
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
     */
    async onReady() {
        this.log.info("Bosch Smart Home Camera adapter starting…");
        // Validate config
        if (!this.config.username || !this.config.password) {
            this.log.error("Username and password must be set in the adapter configuration");
            this.terminate?.("Missing credentials — configure in Admin UI", 11) ??
                this.log.warn("terminate() not available — adapter will idle");
            return;
        }
        // Ensure object tree for info/token states
        await this.ensureInfoObjects();
        await this.setStateAsync("info.connection", false, true);
        // ── Step 1: Obtain tokens ──────────────────────────────────────────
        let tokens;
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
        }
        else {
            this.log.info("No valid tokens stored — performing fresh login");
            try {
                tokens = await (0, login_1.loginWithCredentials)(this._httpClient, this.config.username, this.config.password);
                this.log.info("Login successful");
                await this.saveTokens(tokens);
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                this.log.error(`Login failed: ${msg}`);
                await this.setStateAsync("info.connection", false, true);
                this.terminate?.("Login failed — check credentials in Admin UI", 11) ??
                    this.log.warn("terminate() not available — adapter will idle");
                return;
            }
        }
        // ── Step 2: Discover cameras ───────────────────────────────────────
        let cameras;
        try {
            cameras = await (0, cameras_1.fetchCameras)(this._httpClient, tokens.access_token);
            this.log.info(`Found ${cameras.length} camera(s)`);
        }
        catch (err) {
            if (err instanceof cameras_1.UnauthorizedError) {
                // Token rejected despite being fresh — refresh and retry once
                this.log.warn("Camera discovery returned 401 — attempting token refresh before retry");
                try {
                    const refreshed = await (0, auth_1.refreshAccessToken)(this._httpClient, tokens.refresh_token);
                    if (!refreshed)
                        throw new Error("refresh returned null");
                    await this.saveTokens(refreshed);
                    cameras = await (0, cameras_1.fetchCameras)(this._httpClient, refreshed.access_token);
                    tokens = refreshed;
                }
                catch (retryErr) {
                    const msg = retryErr instanceof Error ? retryErr.message : String(retryErr);
                    this.log.error(`Camera discovery failed after token refresh: ${msg}`);
                    await this.setStateAsync("info.connection", false, true);
                    return;
                }
            }
            else {
                const msg = err instanceof Error ? err.message : String(err);
                this.log.error(`Camera discovery failed: ${msg}`);
                await this.setStateAsync("info.connection", false, true);
                return;
            }
        }
        // ── Step 3: Create state tree ──────────────────────────────────────
        await this.ensureCameraObjects(cameras);
        // ── Step 4: Mark connected + arm refresh loop ──────────────────────
        await this.upsertState("info.connection", true);
        this.scheduleTokenRefresh(tokens.expires_in * 1000);
        this.log.info(`Bosch Smart Home Camera adapter ready — ${cameras.length} camera(s) active`);
    }
    /**
     * Called whenever a subscribed state changes.
     * Only acts on ack=false states (user commands, not adapter-reported values).
     *
     * TODO: Route to camera command handler (privacy, light, snapshot).
     */
    onStateChange(id, state) {
        if (!state) {
            this.log.debug(`State ${id} deleted`);
            return;
        }
        if (state.ack)
            return; // ignore adapter-reported (ack=true), only handle user commands
        this.log.debug(`State change command: ${id} = ${state.val}`);
        // TODO: route to per-camera command handler (privacy_mode, camera_light, snapshot.request)
    }
    /**
     * Called when the adapter is stopped.
     * Clears the refresh timer and sets info.connection = false.
     * Must always call callback() — ioBroker enforces a timeout.
     */
    onUnload(callback) {
        try {
            // Clear the refresh timer (this.clearTimeout auto-tracks via adapter-core)
            if (this._refreshTimeout) {
                this.clearTimeout(this._refreshTimeout);
                this._refreshTimeout = null;
            }
            // Synchronous best-effort connection flag (async not guaranteed to complete)
            void this.setStateAsync("info.connection", false, true).catch(() => undefined);
            this.log.info("Bosch Smart Home Camera adapter stopped");
        }
        catch {
            // swallow — we must always call callback
        }
        finally {
            callback();
        }
    }
}
exports.BoschSmartHomeCamera = BoschSmartHomeCamera;
// ── Bootstrap ─────────────────────────────────────────────────────────────────
if (require.main !== module) {
    // Called by ioBroker adapter host — export factory
    module.exports = (options) => new BoschSmartHomeCamera(options);
}
else {
    // Run directly for local debugging: node build/main.js
    (() => new BoschSmartHomeCamera())();
}
//# sourceMappingURL=main.js.map