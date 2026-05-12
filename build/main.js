"use strict";
/**
 * Bosch Smart Home Camera — ioBroker Adapter
 *
 * Entry point. Authenticates against Bosch Keycloak (OAuth2 PKCE),
 * discovers cameras via the Bosch Residential Cloud API, and manages
 * ioBroker state objects for each camera entity.
 *
 * Implementation roadmap (skeleton stubs only in v0.1.0):
 *   1. [auth.ts]   OAuth2 PKCE login → access_token + refresh_token
 *   2. [cameras.ts] GET /v1/accounts/{id}/cameras → camera list
 *   3. [states.ts]  Create ioBroker state tree per camera
 *   4. [stream.ts]  Register go2rtc RTSPS sources per camera
 *   5. [fcm.ts]     FCM push registration → motion/audio/person events
 *   6. [digest.ts]  HTTP Digest auth for local camera RCP+ commands
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
const utils = __importStar(require("@iobroker/adapter-core"));
require("./lib/adapter-config"); // augment ioBroker.AdapterConfig with our typed settings
// ── Adapter class ─────────────────────────────────────────────────────────────
class BoschSmartHomeCamera extends utils.Adapter {
    refreshTimer = null;
    constructor(options = {}) {
        super({
            ...options,
            name: "bosch-smart-home-camera",
        });
        this.on("ready", this.onReady.bind(this));
        this.on("stateChange", this.onStateChange.bind(this));
        this.on("unload", this.onUnload.bind(this));
    }
    /**
     * Called once the adapter DB connection is ready and subscriptions are active.
     *
     * TODO (Step 1): Read username/password from this.config, call loginOAuth2().
     * TODO (Step 2): Call Cloud API GET /v1/accounts/{accountId}/cameras.
     * TODO (Step 3): For each camera, call this.setObjectNotExists() to create
     *                state objects (snapshot, privacy, light, stream_url, …).
     * TODO (Step 4): Register RTSPS source with go2rtc (if configured).
     * TODO (Step 5): Subscribe to FCM push for motion/person/audio events.
     * TODO (Step 6): Start token refresh timer (access_token expires in ~300s).
     */
    async onReady() {
        this.log.info("Bosch Smart Home Camera adapter starting…");
        this.log.info(`Config: username=${this.config.username ?? "(not set)"}, ` +
            `region=${this.config.region ?? "EU"}`);
        // TODO Step 1: OAuth2 login
        // const tokens = await loginOAuth2(this.config.username, this.config.password);
        // this.log.info("Authenticated with Bosch SingleKey ID");
        // TODO Step 2: Discover cameras
        // const cameras = await discoverCameras(tokens.access_token);
        // this.log.info(`Found ${cameras.length} cameras`);
        // TODO Step 3: Create state objects
        // for (const cam of cameras) { await this.createCameraObjects(cam); }
        // Placeholder: set connection indicator
        await this.setStateAsync("info.connection", { val: false, ack: true });
        this.log.warn("Adapter skeleton loaded — no camera data yet (v0.1.0 pre-alpha)");
    }
    /**
     * Called whenever a subscribed state changes.
     *
     * TODO: Handle control states (privacy_mode, camera_light, stream_start).
     * Route commands to local RCP+ (Digest auth via digest.ts) or cloud API.
     */
    onStateChange(id, state) {
        if (!state) {
            this.log.debug(`State ${id} deleted`);
            return;
        }
        if (state.ack)
            return; // ignore confirmed states, only act on commands
        this.log.debug(`State change command: ${id} = ${state.val}`);
        // TODO: route to camera command handler
    }
    /**
     * Called when the adapter is stopped (ioBroker restart, manual stop, update).
     * Must call callback() when cleanup is done — ioBroker enforces a timeout.
     */
    onUnload(callback) {
        try {
            if (this.refreshTimer) {
                clearInterval(this.refreshTimer);
                this.refreshTimer = null;
            }
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