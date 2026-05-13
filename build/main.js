"use strict";
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
// adapter-config.d.ts augments ioBroker.AdapterConfig — included via tsconfig src/**/*.ts,
// no runtime import needed (import would fail: .d.ts files produce no .js output)
const auth_1 = require("./lib/auth");
// login.ts is kept for tests / future headless paths but not called from here.
// See deprecation notice in src/lib/login.ts.
const cameras_1 = require("./lib/cameras");
const live_session_1 = require("./lib/live_session");
const rcp_1 = require("./lib/rcp");
const snapshot_1 = require("./lib/snapshot");
const tls_proxy_1 = require("./lib/tls_proxy");
const fcm_1 = require("./lib/fcm");
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
    /** Live sessions keyed by camera ID. Re-opened when stale. */
    _liveSessions = new Map();
    /** TLS proxy handles keyed by camera ID. */
    _tlsProxies = new Map();
    /** Camera metadata keyed by camera ID (populated in onReady from fetchCameras). */
    _cameras = new Map();
    /** FCM push listener (null until onReady wires it up). */
    _fcmListener = null;
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
                    },
                    native: {},
                });
            }
        }
        catch (err) {
            this.log.warn(`Could not ensure meta object for file storage: ${err.message}`);
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
                name: "FCM push listener status: healthy / stub / error / stopped",
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
                    name: "Camera light",
                    role: "switch.light",
                    type: "boolean",
                    read: true,
                    write: true,
                    def: false,
                },
                native: {},
            });
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
    // ── Live session management ─────────────────────────────────────────────
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
    async ensureLiveSession(camId) {
        const SESSION_TTL_MS = 30_000; // 30 s conservative re-open threshold
        const existing = this._liveSessions.get(camId);
        if (existing && Date.now() - existing.openedAt < SESSION_TTL_MS) {
            return existing; // still fresh
        }
        if (!this._currentAccessToken) {
            throw new Error(`Cannot open live session for ${camId} — no access token`);
        }
        // Open a fresh session (AUTO mode: LOCAL first, falls back to REMOTE on network error)
        const session = await (0, live_session_1.openLiveSession)(this._httpClient, this._currentAccessToken, camId, "AUTO");
        this._liveSessions.set(camId, session);
        // Spawn (or replace) the TLS proxy for the stream URL
        try {
            const existingProxy = this._tlsProxies.get(camId);
            if (existingProxy) {
                // Stop old proxy silently before starting a new one
                await existingProxy.stop().catch(() => undefined);
                this._tlsProxies.delete(camId);
            }
            // Derive remote host + port from the session
            let remoteHost;
            let remotePort;
            if (session.connectionType === "LOCAL" && session.lanAddress) {
                // lanAddress: "192.168.x.x:443"
                const [h, pStr] = session.lanAddress.split(":");
                remoteHost = h;
                remotePort = parseInt(pStr ?? "443", 10);
            }
            else {
                // REMOTE: proxyUrl = "https://proxy-NN:42090/{hash}/snap.jpg?..."
                // Extract host and port from URL
                try {
                    const u = new URL(session.proxyUrl);
                    remoteHost = u.hostname;
                    remotePort = u.port ? parseInt(u.port, 10) : 443;
                }
                catch {
                    remoteHost = "residential.cbs.boschsecurity.com";
                    remotePort = 42090;
                }
            }
            const proxyHandle = await (0, tls_proxy_1.startTlsProxy)({
                remoteHost,
                remotePort,
                cameraId: camId,
                log: (level, msg) => this.log[level](msg),
            });
            this._tlsProxies.set(camId, proxyHandle);
            // Write stream URL to state
            await this.setObjectNotExistsAsync(`cameras.${camId}.stream_url`, {
                type: "state",
                common: {
                    name: "Local RTSP URL for RTSPS stream",
                    role: "text.url",
                    type: "string",
                    read: true,
                    write: false,
                    def: "",
                },
                native: {},
            });
            await this.upsertState(`cameras.${camId}.stream_url`, proxyHandle.localRtspUrl);
            this.log.info(`TLS proxy for camera ${camId.slice(0, 8)}: ` +
                `stream_url = ${proxyHandle.localRtspUrl}`);
        }
        catch (proxyErr) {
            // TLS proxy failure is non-fatal for RCP/snapshot — log and continue
            const msg = proxyErr instanceof Error ? proxyErr.message : String(proxyErr);
            this.log.warn(`Could not start TLS proxy for ${camId}: ${msg}`);
        }
        return session;
    }
    /**
     * Derive the rcp.xml base URL from a live session.
     *
     * LOCAL:  "https://192.168.x.x:443/rcp.xml"
     * REMOTE: "https://proxy-NN:42090/{hash}/rcp.xml"
     */
    getRcpUrl(session) {
        // proxyUrl is the snap.jpg URL — strip the snap.jpg path and query to get the base
        // e.g. "https://192.0.2.10:443/snap.jpg?JpegSize=1206" → "https://192.0.2.10:443/rcp.xml"
        // e.g. "https://proxy-NN:42090/{hash}/snap.jpg?JpegSize=1206" → "https://proxy-NN:42090/{hash}/rcp.xml"
        try {
            const u = new URL(session.proxyUrl);
            // Replace everything after the last '/' before snap.jpg
            const basePath = u.pathname.replace(/\/snap\.jpg.*$/, "");
            return `${u.protocol}//${u.host}${basePath}/rcp.xml`;
        }
        catch {
            // Fallback: simple string replacement
            return session.proxyUrl.replace(/\/snap\.jpg.*$/, "/rcp.xml");
        }
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
    async showLoginUrl() {
        // Check if we already have a stored verifier (reuse across restarts)
        const existingVerifier = (await this.getStateAsync("info.pkce_verifier"))?.val;
        let verifier;
        let challenge;
        let state;
        if (existingVerifier && existingVerifier.length > 10) {
            // Reuse stored verifier — derive challenge from it
            const { createHash, randomBytes } = await Promise.resolve().then(() => __importStar(require("crypto")));
            verifier = existingVerifier;
            challenge = createHash("sha256").update(verifier).digest("base64url");
            const existingState = (await this.getStateAsync("info.pkce_state"))?.val;
            state = (existingState && existingState.length > 4) ? existingState : randomBytes(16).toString("base64url");
        }
        else {
            // Generate a fresh PKCE pair
            const { randomBytes } = await Promise.resolve().then(() => __importStar(require("crypto")));
            const pair = (0, auth_1.generatePkcePair)();
            verifier = pair.verifier;
            challenge = pair.challenge;
            state = randomBytes(16).toString("base64url");
            await this.setStateAsync("info.pkce_verifier", verifier, true);
            await this.setStateAsync("info.pkce_state", state, true);
        }
        const authUrl = (0, auth_1.buildAuthUrl)(challenge, state);
        this.log.info("Login required. Open this URL in your browser and log in to Bosch:");
        this.log.info(authUrl);
        this.log.info("After Bosch redirects you, copy the full redirect URL " +
            "(https://www.bosch.com/boschcam?code=...&state=...) " +
            "and paste it into the 'redirect_url' field in Admin UI, then save.");
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
    async handleRedirectPaste(url) {
        const code = (0, auth_1.extractCode)(url);
        if (!code) {
            throw new Error("No 'code' parameter found in pasted URL. " +
                "Make sure to copy the full URL from the browser address bar after Bosch redirects you.");
        }
        const verifier = (await this.getStateAsync("info.pkce_verifier"))?.val;
        if (!verifier || verifier.length < 10) {
            throw new Error("No PKCE verifier stored. " +
                "Please restart the adapter first (without a redirect_url) to generate a login URL, " +
                "then open that URL in your browser before pasting the redirect URL.");
        }
        const tokens = await (0, auth_1.exchangeCode)(this._httpClient, code, verifier);
        if (!tokens) {
            throw new Error("Token exchange returned null (transient network error). " +
                "Please try again — paste the same redirect URL or generate a new login URL.");
        }
        await this.saveTokens(tokens);
        // Clear paste field so it is not re-used on the next adapter restart
        try {
            await this.extendForeignObjectAsync(`system.adapter.${this.namespace}`, { native: { redirect_url: "" } });
        }
        catch {
            // Non-fatal — log at debug level; the code has been consumed anyway
            this.log.debug("Could not clear redirect_url in adapter config — non-fatal");
        }
        // Clear stored PKCE pair (verifier consumed — regenerate fresh on next login)
        await this.setStateAsync("info.pkce_verifier", "", true);
        await this.setStateAsync("info.pkce_state", "", true);
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
     * 7. Start FCM listener (stub → sets info.fcm_active = "stub")
     */
    async onReady() {
        this.log.info("Bosch Smart Home Camera adapter starting…");
        // Ensure object tree for info/token states
        await this.ensureInfoObjects();
        await this.setStateAsync("info.connection", false, true);
        // ── Step 1: Obtain tokens (PKCE browser flow) ──────────────────────
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
            // No valid tokens — check if user has pasted a redirect URL
            const pastedUrl = this.config.redirect_url ?? "";
            if (pastedUrl && pastedUrl.includes("code=")) {
                // Step 2: user pasted callback URL — extract code, exchange for tokens
                try {
                    tokens = await this.handleRedirectPaste(pastedUrl);
                }
                catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    this.log.error(`Login failed: ${msg}`);
                    await this.setStateAsync("info.connection", false, true);
                    this.terminate("Login failed — check Admin UI redirect_url field", 11);
                    return;
                }
            }
            else {
                // Step 1: no tokens, no pasted URL — generate PKCE pair and show login URL
                await this.showLoginUrl();
                // Stay alive in "waiting for setup" mode — user needs to paste URL
                await this.setStateAsync("info.connection", false, true);
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
        // Populate in-memory camera cache (used by handlers for Gen1/Gen2 dispatch)
        this._cameras.clear();
        for (const cam of cameras) {
            this._cameras.set(cam.id, cam);
        }
        // Subscribe to all camera states so onStateChange receives user writes
        await this.subscribeStatesAsync("cameras.*");
        // ── Step 4: Mark connected + arm refresh loop ──────────────────────
        await this.upsertState("info.connection", true);
        this.scheduleTokenRefresh(tokens.expires_in * 1000);
        // ── Step 5: FCM listener (stub in v0.2.0) ──────────────────────────
        this._fcmListener = new fcm_1.FcmListener(this._httpClient, tokens.access_token);
        this._fcmListener.on("motion", (ev) => { void this.onFcmEvent(ev); });
        this._fcmListener.on("audio_alarm", (ev) => { void this.onFcmEvent(ev); });
        this._fcmListener.on("person", (ev) => { void this.onFcmEvent(ev); });
        try {
            await this._fcmListener.start();
            await this.setStateAsync("info.fcm_active", "healthy", true);
            this.log.info("FCM push listener started");
        }
        catch (err) {
            if (err instanceof fcm_1.FcmNotImplementedError) {
                this.log.warn("FCM not implemented yet — using polling fallback in v0.3.0+");
                await this.setStateAsync("info.fcm_active", "stub", true);
            }
            else {
                const msg = err instanceof Error ? err.message : String(err);
                this.log.error(`FCM start failed: ${msg}`);
                await this.setStateAsync("info.fcm_active", "error", true);
            }
        }
        this.log.info(`Bosch Smart Home Camera adapter ready — ${cameras.length} camera(s) active`);
    }
    /**
     * Called whenever a subscribed state changes.
     * Only acts on ack=false states (user commands, not adapter-reported values).
     * Routes writes to the appropriate per-camera handler.
     */
    async onStateChange(id, state) {
        if (!state || state.ack)
            return; // ignore null deletions + already-ack'd values
        // id format: <namespace>.cameras.<camId>.<stateName>
        // Strip namespace prefix to get the relative id
        const ns = this.namespace + ".";
        const relId = id.startsWith(ns) ? id.slice(ns.length) : id;
        const idParts = relId.split(".");
        if (idParts[0] !== "cameras" || idParts.length < 3)
            return;
        const camId = idParts[1];
        const stateName = idParts.slice(2).join(".");
        this.log.debug(`State change: ${id} = ${state.val} (from user)`);
        try {
            switch (stateName) {
                case "privacy_enabled":
                    await this.handlePrivacyToggle(camId, Boolean(state.val));
                    break;
                case "light_enabled":
                    await this.handleLightToggle(camId, Boolean(state.val));
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
                default:
                    return; // unknown writable state — no-op
            }
            // On success: ack the state with the value the user requested
            await this.setStateAsync(id, state.val, true);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.log.error(`Failed to handle ${stateName} for ${camId}: ${msg}`);
            // Don't ack — leave state in user-set (ack=false) so it's visible as "pending failed"
        }
    }
    // ── FCM event handler ───────────────────────────────────────────────────
    /**
     * Handle an FCM motion/person/audio_alarm push event.
     * Writes per-camera last_motion_at + last_motion_event_type states.
     */
    async onFcmEvent(ev) {
        const prefix = `cameras.${ev.cameraId}`;
        await this.setStateAsync(`${prefix}.last_motion_at`, ev.timestamp, true);
        await this.setStateAsync(`${prefix}.last_motion_event_type`, ev.eventType, true);
        this.log.info(`FCM event [${ev.eventType}] for camera ${ev.cameraId.slice(0, 8)} at ${ev.timestamp}`);
    }
    // ── Camera command handlers ─────────────────────────────────────────────
    /**
     * Derive Digest credentials from a live session for LOCAL RCP+ calls.
     * Cloud proxy URLs are pre-authenticated via the URL hash — return undefined
     * so the REMOTE codepath is taken in sendRcpCommand().
     */
    getRcpAuth(session) {
        if (session.connectionType === "LOCAL") {
            return { user: session.digestUser, password: session.digestPassword };
        }
        return undefined;
    }
    /**
     * Privacy mode: PUT /v11/video_inputs/{camId}/privacy with
     * { privacyMode: "ON" | "OFF", durationInSeconds: null }.
     *
     * Matches HA's `async_cloud_set_privacy_mode()` in shc.py. Cloud-API path
     * is the primary (fast ~150ms) and works for both Gen1 + Gen2. RCP+ LOCAL
     * is NOT used here because Bosch's Gen2 firmware rejects WRITE 0x0808 over
     * Digest auth (verified live: HTTP 401 even with correct credentials).
     */
    async handlePrivacyToggle(camId, enabled) {
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
     */
    async handleLightToggle(camId, enabled) {
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
            const body = { enabled };
            const [r1, r2] = await Promise.all([
                this._httpClient.put(`${base}/front`, body, { headers, validateStatus: () => true }),
                this._httpClient.put(`${base}/topdown`, body, { headers, validateStatus: () => true }),
            ]);
            const ok1 = [200, 201, 204].includes(r1.status);
            const ok2 = [200, 201, 204].includes(r2.status);
            if (!ok1 && !ok2) {
                throw new Error(`Cloud light PUT Gen2 returned HTTP front=${r1.status} topdown=${r2.status}`);
            }
        }
        else {
            const url = `https://residential.cbs.boschsecurity.com/v11/video_inputs/${camId}/lighting_override`;
            const body = enabled
                ? { frontLightOn: true, wallwasherOn: true, frontLightIntensity: 1.0 }
                : { frontLightOn: false, wallwasherOn: false };
            const resp = await this._httpClient.put(url, body, { headers, validateStatus: () => true });
            if (![200, 201, 204].includes(resp.status)) {
                throw new Error(`Cloud light PUT Gen1 returned HTTP ${resp.status}`);
            }
        }
        this.log.info(`Camera light ${enabled ? "ON" : "OFF"} set for camera ${camId.slice(0, 8)} (gen${isGen2 ? 2 : 1})`);
    }
    /**
     * Image rotation: RCP+ command 0x0810 WRITE (Digest for LOCAL, hash for REMOTE).
     */
    async handleImageRotationToggle(camId, rotated180) {
        const session = await this.ensureLiveSession(camId);
        const rcpUrl = this.getRcpUrl(session);
        const frame = (0, rcp_1.buildSetImageRotationFrame)(rotated180);
        await (0, rcp_1.sendRcpCommand)(this._httpClient, rcpUrl, frame, undefined, this.getRcpAuth(session));
        this.log.info(`Image rotation ${rotated180 ? "180°" : "0°"} set for camera ${camId.slice(0, 8)}`);
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
     */
    async handleSnapshotTrigger(camId) {
        const session = await this.ensureLiveSession(camId);
        const snapUrl = (0, snapshot_1.buildSnapshotUrl)(session.proxyUrl);
        let buf;
        try {
            buf = await (0, snapshot_1.fetchSnapshot)(snapUrl, session.connectionType, session.digestUser, session.digestPassword);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            // Only retry on "aborted" / connection-reset errors — not on auth (401)
            // or non-image content type (no point retrying those).
            const isTransient = /abort|reset|ECONNRESET|socket hang up|timeout/i.test(msg);
            if (!isTransient)
                throw err;
            this.log.debug(`Snapshot retry for ${camId.slice(0, 8)}: ${msg}`);
            await new Promise((r) => setTimeout(r, 800));
            buf = await (0, snapshot_1.fetchSnapshot)(snapUrl, session.connectionType, session.digestUser, session.digestPassword);
        }
        const filePath = `cameras/${camId}/snapshot.jpg`;
        await this.writeFileAsync(this.namespace, filePath, buf);
        await this.setStateAsync(`cameras.${camId}.snapshot_path`, `/${this.namespace}/${filePath}`, true);
        this.log.info(`Snapshot saved for camera ${camId.slice(0, 8)}: ${buf.length} bytes`);
    }
    /**
     * Called when the adapter is stopped.
     * Cleans up TLS proxies, FCM listener, live sessions, and the refresh timer.
     * Must always call callback() — ioBroker enforces a timeout.
     */
    onUnload(callback) {
        void (async () => {
            try {
                // Clear the refresh timer (this.clearTimeout auto-tracks via adapter-core)
                if (this._refreshTimeout) {
                    this.clearTimeout(this._refreshTimeout);
                    this._refreshTimeout = null;
                }
                // Stop FCM listener
                if (this._fcmListener) {
                    try {
                        await this._fcmListener.stop();
                    }
                    catch { /* best-effort */ }
                    this._fcmListener = null;
                }
                // Stop all TLS proxies
                for (const [, handle] of this._tlsProxies) {
                    try {
                        await handle.stop();
                    }
                    catch { /* best-effort */ }
                }
                this._tlsProxies.clear();
                // Close all live sessions (best-effort — camera may be gone)
                if (this._currentAccessToken) {
                    const token = this._currentAccessToken;
                    for (const [camId] of this._liveSessions) {
                        try {
                            await (0, live_session_1.closeLiveSession)(this._httpClient, token, camId);
                        }
                        catch { /* best-effort */ }
                    }
                }
                this._liveSessions.clear();
                // Best-effort connection flag (async — may not complete if ioBroker kills us)
                void this.setStateAsync("info.connection", false, true).catch(() => undefined);
                void this.setStateAsync("info.fcm_active", "stopped", true).catch(() => undefined);
                this.log.info("Bosch Smart Home Camera adapter stopped");
            }
            catch {
                // swallow — we must always call callback
            }
            finally {
                callback();
            }
        })();
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