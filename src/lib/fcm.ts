/**
 * FCM (Firebase Cloud Messaging) push receiver for Bosch Smart Home Camera.
 *
 * Port of the Python fcm.py → TypeScript EventEmitter pattern using @aracna/fcm.
 *
 * ## Library: @aracna/fcm v1.0.32
 *
 * Speaks MTalk/MCS protocol to mtalk.google.com:5228, same as the Python
 * firebase-messaging (sdb9696). Registration flow:
 *   1. createFcmECDH() + generateFcmAuthSecret() → ECDH key pair + auth secret
 *   2. registerToFCM({ appID, ece, firebase }) → { acg: { id, securityToken }, token }
 *   3. FcmClient({ acg, ece }).connect() → persistent TLS socket, emits "message-data"
 *
 * FCM push from Bosch is a silent wake-up ("data-only" message) — no notification
 * payload. The adapter fetches fresh events from /v11/events on each push.
 *
 * ## Push mode
 * - "ios":     register as iOS app (FCM_IOS_APP_ID) — matches Python HA integration default
 * - "android": register as Android app
 * - "auto":    try iOS first, fall back to Android (same as Python fcm.py)
 *
 * ## Credential persistence
 * ACG ID / ACG security token / ECDH keys must be persisted across restarts to avoid
 * re-registration on every adapter start. Pass `savedCredentials.raw` (FcmCredentials.raw)
 * back in on the next start — same pattern as Python `saved_fcm_creds`.
 *
 * ## Reconnect
 * The FcmClient does NOT auto-reconnect on socket close. The caller is responsible for
 * re-calling start() after a "disconnect" event (with exponential back-off). The
 * coordinator's watchdog timer handles this.
 *
 * Constants mirrored from Python fcm.py:
 *   FCM_SENDER_ID = "404630424405"
 *   FCM_IOS_APP_ID = "1:404630424405:ios:715aae2570e39faad9bddc"
 *
 * Firebase config (Android, "bosch-smart-cameras" project) — public app identifiers
 * embedded in every Bosch Smart Camera APK, confirmed by Bosch.
 */

import { EventEmitter } from "events";
import type { AxiosInstance } from "axios";
import {
    FcmClient,
    createFcmECDH,
    generateFcmAuthSecret,
    registerToFCM,
    type FcmClientMessageData,
    type FcmRegistration,
} from "@aracna/fcm";

// ── Constants (from Python fcm.py) ───────────────────────────────────────────

export const CLOUD_API = "https://residential.cbs.boschsecurity.com";
export const FCM_SENDER_ID = "404630424405";
export const FCM_IOS_APP_ID = `1:${FCM_SENDER_ID}:ios:715aae2570e39faad9bddc`;
export const FCM_ANDROID_APP_ID = `1:${FCM_SENDER_ID}:android:9e5b6b58e4c70075`;

// Firebase project IDs — public, embedded in Bosch APK
const FCM_PROJECT_ID = "bosch-smart-cameras";

// Android Firebase API key (base64-encoded per Python fetch_firebase_config)
// Official OSS key from Bosch — Firebase/FCM perms confirmed.
const FCM_ANDROID_API_KEY = Buffer.from(
    "QUl6YVN5Q0toaGZ4ZlRzMUc3V3Z6VERBaU8wQWlzN0VIMjVEYk9z",
    "base64",
).toString("utf8");

// iOS Firebase API key (base64-encoded per Python _build_fcm_cfg ios branch)
const FCM_IOS_API_KEY = Buffer.from(
    "QUl6YVN5QmxyN1o0ZmpaM0lmcnhsN1VRZFE4eGZRd3g5WFJBYnBJ",
    "base64",
).toString("utf8");

// VAPID key from Bosch Firebase project (from fcm_credentials.json config.vapid_key)
const FCM_VAPID_KEY =
    "BDOU99-h67HcA6JeFXHbSNMu7e2yNNu3RzoMj8TM4W88jITfq7ZmPvIM1Iv-4_l2LxQcYwhqby2xGpWwzjfAnG4";

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Payload emitted on every motion / audio-alarm / person event.
 * Mirrors the event_payload dict in Python fcm.py _on_fcm_push().
 */
export interface FcmEventPayload {
    /** Bosch camera UUID (videoInputId) */
    cameraId: string;
    /** Human-readable camera name */
    cameraName: string;
    /** ISO 8601 timestamp from Bosch event API */
    timestamp: string;
    /** Normalised event type */
    eventType: "motion" | "audio_alarm" | "person";
    /** Bosch cloud image URL (may be empty until clip is ready) */
    imageUrl?: string;
    /** Bosch cloud event UUID */
    eventId?: string;
}

/**
 * Persisted FCM credential blob — must be stored by the caller and passed back
 * in on the next adapter start via `savedCredentials.raw` to avoid re-registration.
 * Mirrors `saved_fcm_creds` pattern in Python HA integration.
 */
export interface FcmRawCredentials {
    /** ACG ID as a decimal string (bigint can't be JSON-serialised natively) */
    acgId: string;
    /** ACG security token as a decimal string */
    acgSecurityToken: string;
    /** ECE auth secret (Uint8Array serialised as number array for JSON) */
    authSecret: number[];
    /** ECDH private key (Uint8Array serialised as number array for JSON) */
    ecdhPrivateKey: number[];
    /** ECDH public key (Uint8Array serialised as number array for JSON) */
    ecdhPublicKey: number[];
    /** Push mode used for this registration */
    mode: "ios" | "android";
}

/**
 * FCM credentials returned after successful registration.
 * Intended to be persisted by the caller across restarts.
 */
export interface FcmCredentials {
    fcmToken: string;
    /** Push mode actually used ("ios" | "android") */
    mode: "ios" | "android";
    /** Raw credential blob for persistence across restarts (pass as savedCredentials.raw) */
    raw: FcmRawCredentials;
}

/**
 * Options for FcmListener construction.
 */
export interface FcmListenerOptions {
    /**
     * Push registration mode.
     * - "ios"     → register as iOS app (FCM_IOS_APP_ID)
     * - "android" → register as Android app
     * - "auto"    → try iOS first, fall back to Android (default)
     */
    mode?: "ios" | "android" | "auto";
    /**
     * Previously saved credentials (survives adapter restart — skip re-register
     * if token is still valid). Mirrors `saved_fcm_creds` in Python.
     */
    savedCredentials?: FcmCredentials;
}

// ── Error classes ─────────────────────────────────────────────────────────────

/**
 * Thrown when CBS device registration fails with a non-retryable HTTP error.
 */
export class FcmCbsRegistrationError extends Error {
    constructor(
        public readonly httpStatus: number,
        message: string,
    ) {
        super(message);
        this.name = "FcmCbsRegistrationError";
    }
}

/**
 * Thrown when FCM registration fails (network error or Google API rejection).
 */
export class FcmRegistrationError extends Error {
    constructor(message: string, public readonly cause?: unknown) {
        super(message);
        this.name = "FcmRegistrationError";
    }
}

// ── FcmListener ───────────────────────────────────────────────────────────────

/**
 * FCM push-notification listener for Bosch Smart Home Camera events.
 *
 * Events emitted:
 *   "motion"      → FcmEventPayload
 *   "audio_alarm" → FcmEventPayload
 *   "person"      → FcmEventPayload
 *   "push"        → FcmClientMessageData (raw push, for coordinator to fetch events)
 *   "registered"  → FcmCredentials
 *   "error"       → Error
 *   "disconnect"  → void
 *
 * Usage:
 * ```typescript
 * const fcm = new FcmListener(httpClient, bearerToken);
 * fcm.on("push", () => { coordinator.fetchEvents(); });
 * fcm.on("registered", (creds) => { saveCredentials(creds); });
 * await fcm.start();
 * // ...
 * await fcm.stop();
 * ```
 *
 * Note: Bosch pushes are silent wake-up signals with no event payload. The
 * coordinator should listen to "push" and immediately call the Bosch /v11/events
 * API — same as Python async_handle_fcm_push().
 * The "motion", "audio_alarm", "person" events are emitted only when the raw
 * push message contains explicit event-type data in its data dict.
 */
/**
 * Injectable FCM dependencies — allows tests to override the @aracna/fcm
 * functions without sinon module-property stubbing (which fails on ES module
 * non-configurable exports).
 *
 * Production code uses the real @aracna/fcm functions (default).
 * Tests pass a `deps` object with sinon stubs.
 */
export interface FcmDeps {
    registerToFCM: typeof registerToFCM;
    createFcmECDH: typeof createFcmECDH;
    generateFcmAuthSecret: typeof generateFcmAuthSecret;
    FcmClient: typeof FcmClient;
}

/** Default production deps — real @aracna/fcm functions. */
const DEFAULT_DEPS: FcmDeps = {
    registerToFCM,
    createFcmECDH,
    generateFcmAuthSecret,
    FcmClient,
};

export class FcmListener extends EventEmitter {
    private readonly _httpClient: AxiosInstance;
    private readonly _bearerToken: string;
    private readonly _options: FcmListenerOptions;
    /** Injectable deps — overridable in tests. */
    readonly _deps: FcmDeps;

    private _fcmToken: string | null = null;
    private _running = false;
    private _clientHandle: FcmClient | null = null;

    constructor(
        httpClient: AxiosInstance,
        bearerToken: string,
        options?: FcmListenerOptions,
        deps?: Partial<FcmDeps>,
    ) {
        super();
        this._httpClient = httpClient;
        this._bearerToken = bearerToken;
        this._options = options ?? {};
        this._deps = { ...DEFAULT_DEPS, ...deps };
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /**
     * Register with FCM and start listening for push notifications.
     *
     * Step 1: Generate or restore ECDH key pair + auth secret.
     * Step 2: Register with Google FCM (registerToFCM) → get ACG tokens + FCM token.
     * Step 3: Register the FCM token with Bosch CBS (POST /v11/devices).
     * Step 4: Start FcmClient TLS socket → emit "push" on every incoming message.
     *
     * @emits "registered" with FcmCredentials once FCM + CBS registration complete.
     * @throws FcmRegistrationError   if Google FCM registration fails.
     * @throws FcmCbsRegistrationError if Bosch CBS rejects the token (HTTP 4xx).
     */
    async start(): Promise<void> {
        if (this._running) {
            return;
        }

        const mode = this._options.mode ?? "auto";

        if (mode === "auto") {
            // Try iOS first, then Android — mirrors Python _try_fcm_with_mode logic
            const iosOk = await this._tryStart("ios");
            if (iosOk) return;
            const androidOk = await this._tryStart("android");
            if (!androidOk) {
                throw new FcmRegistrationError(
                    "FCM: both iOS and Android registration failed — check network and Firebase credentials",
                );
            }
        } else {
            const ok = await this._tryStart(mode);
            if (!ok) {
                throw new FcmRegistrationError(
                    `FCM: registration failed for mode '${mode}'`,
                );
            }
        }
    }

    /**
     * Stop the listener cleanly. Closes the MTalk TLS socket and sets state to
     * stopped. Safe to call multiple times (idempotent).
     * @emits "disconnect"
     */
    async stop(): Promise<void> {
        if (!this._running) {
            return;
        }
        this._running = false;
        const client = this._clientHandle;
        this._clientHandle = null;
        this._fcmToken = null;
        if (client) {
            try {
                await client.disconnect();
            } catch {
                // Ignore — we're stopping anyway
            }
        }
        this.emit("disconnect");
    }

    /**
     * Returns the current FCM device token, or null if not yet registered.
     */
    getFcmToken(): string | null {
        return this._fcmToken;
    }

    /**
     * Returns true when the FCM TLS socket is active and receiving pushes.
     */
    isHealthy(): boolean {
        return this._running && this._clientHandle !== null;
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

    /**
     * Attempt FCM registration + CBS registration + client start for a single mode.
     * Returns true on success, false on any error (caller logs and falls back).
     */
    private async _tryStart(mode: "ios" | "android"): Promise<boolean> {
        const deps = this._deps;
        try {
            // Step 1: Restore or generate ECDH key pair + auth secret
            const saved = this._options.savedCredentials?.raw;
            let ecdh = deps.createFcmECDH();
            let authSecret: Buffer;
            let acgInit: { id?: bigint; securityToken?: bigint } | undefined;

            if (saved && saved.mode === mode) {
                // Restore persisted keys so we can reuse the existing ACG registration
                authSecret = Buffer.from(saved.authSecret);
                // Restore the ECDH private key into a new ECDH instance
                ecdh = deps.createFcmECDH();
                ecdh.setPrivateKey(Buffer.from(saved.ecdhPrivateKey));
                acgInit = {
                    id: BigInt(saved.acgId),
                    securityToken: BigInt(saved.acgSecurityToken),
                };
            } else {
                authSecret = deps.generateFcmAuthSecret();
            }

            const appID = mode === "ios" ? FCM_IOS_APP_ID : FCM_ANDROID_APP_ID;
            const apiKey = mode === "ios" ? FCM_IOS_API_KEY : FCM_ANDROID_API_KEY;
            const publicKey = ecdh.getPublicKey() as Uint8Array;

            // Step 2: Register with Google FCM
            const regConfig = {
                acg: acgInit,
                appID,
                ece: {
                    authSecret: Uint8Array.from(authSecret),
                    publicKey: Uint8Array.from(publicKey),
                },
                firebase: {
                    apiKey,
                    appID: mode === "ios" ? FCM_IOS_APP_ID : FCM_ANDROID_APP_ID,
                    projectID: FCM_PROJECT_ID,
                },
                vapidKey: FCM_VAPID_KEY,
            };

            const reg = await deps.registerToFCM(regConfig);
            if (reg instanceof Error) {
                throw new FcmRegistrationError(
                    `FCM registerToFCM failed (mode=${mode}): ${reg.message}`,
                    reg,
                );
            }

            const fcmRegistration = reg as FcmRegistration;
            this._fcmToken = fcmRegistration.token;

            // Build raw credentials for persistence
            const rawCreds: FcmRawCredentials = {
                acgId: fcmRegistration.acg.id.toString(),
                acgSecurityToken: fcmRegistration.acg.securityToken.toString(),
                authSecret: Array.from(authSecret),
                ecdhPrivateKey: Array.from(ecdh.getPrivateKey() as Uint8Array),
                ecdhPublicKey: Array.from(publicKey),
                mode,
            };

            const creds: FcmCredentials = {
                fcmToken: fcmRegistration.token,
                mode,
                raw: rawCreds,
            };

            // Step 3: Register FCM token with Bosch CBS
            await this._registerWithCbs(fcmRegistration.token, mode);

            // Emit registered event so caller can persist credentials
            this.emit("registered", creds);

            // Step 4: Start FcmClient TLS socket
            const client = new deps.FcmClient({
                acg: {
                    id: fcmRegistration.acg.id,
                    securityToken: fcmRegistration.acg.securityToken,
                },
                ece: {
                    authSecret: Uint8Array.from(authSecret),
                    privateKey: Uint8Array.from(ecdh.getPrivateKey() as Uint8Array),
                },
            });

            client.on("message-data", (data: FcmClientMessageData) => {
                this._onPush(data);
            });

            client.on("close", () => {
                // MTalk server closed the connection — caller must re-call start()
                // to reconnect (with back-off). Do not auto-reconnect here; the
                // coordinator's watchdog handles this.
                this._running = false;
                this._clientHandle = null;
                this.emit("disconnect");
            });

            const connectResult = await client.connect();
            if (connectResult instanceof Error) {
                throw connectResult;
            }

            this._clientHandle = client;
            this._running = true;

            return true;
        } catch (err: unknown) {
            // Do not emit "error" here — _tryStart is internal. The caller
            // (start()) will emit "error" or throw FcmRegistrationError once all
            // modes have been tried. Emitting "error" from _tryStart without a
            // listener crashes the process (Node EventEmitter behaviour).
            return false;
        }
    }

    /**
     * Register the FCM device token with Bosch CBS.
     *
     * Endpoint: POST /v11/devices  { deviceType: "IOS"|"ANDROID", deviceToken }
     * HTTP 204 → success. HTTP 500 + "sh:internal.error" → already registered
     * (treat as success, same as Python register_fcm_with_bosch()).
     *
     * @throws FcmCbsRegistrationError on non-retryable HTTP 4xx.
     */
    async _registerWithCbs(token: string, mode: "ios" | "android"): Promise<void> {
        const deviceType = mode === "ios" ? "IOS" : "ANDROID";
        const resp = await this._httpClient.post(
            `${CLOUD_API}/v11/devices`,
            { deviceType, deviceToken: token },
            {
                headers: {
                    Authorization: `Bearer ${this._bearerToken}`,
                    "Content-Type": "application/json",
                },
                // Don't throw on non-2xx so we can inspect the body
                validateStatus: () => true,
            },
        );
        const status = resp.status as number;
        if (status === 200 || status === 201 || status === 204) {
            return; // success
        }
        // Bosch returns HTTP 500 "sh:internal.error" for duplicate registrations
        if (status === 500) {
            const body = typeof resp.data === "string" ? resp.data : JSON.stringify(resp.data ?? "");
            if (body.includes("sh:internal.error")) {
                return; // already registered — treat as success
            }
        }
        const body = typeof resp.data === "string" ? resp.data : JSON.stringify(resp.data ?? "");
        if (status >= 400 && status < 500) {
            throw new FcmCbsRegistrationError(
                status,
                `CBS /v11/devices HTTP ${status}: ${body.slice(0, 200)}`,
            );
        }
        // 5xx other than duplicate — transient, caller may retry
        throw new Error(`CBS /v11/devices HTTP ${status}: ${body.slice(0, 200)}`);
    }

    /**
     * Handle an incoming FCM push message from Bosch.
     *
     * Bosch pushes are typically silent wake-ups (no event-type data in payload).
     * Always emits "push" so the coordinator can fetch /v11/events immediately.
     * If the data dict contains event type info, also parses and emits the typed event.
     *
     * Mirrors Python _on_fcm_push() + async_handle_fcm_push() flow.
     */
    private _onPush(data: FcmClientMessageData): void {
        // Emit raw push so coordinator can trigger event fetch
        this.emit("push", data);

        // Best-effort: parse typed event if the push contains explicit data
        if (data.data && Object.keys(data.data).length > 0) {
            const parsed = this._parseNotification(
                data.data as Record<string, unknown>,
            );
            if (parsed) {
                this.emit(parsed.eventType, parsed);
            }
        }
    }

    /**
     * Parse a raw FCM notification payload into a typed FcmEventPayload.
     * Mirrors the event-type normalisation in Python _on_fcm_push() +
     * async_handle_fcm_push():
     *   - eventType=MOVEMENT + eventTags=["PERSON"] → eventType="person"
     *   - eventType=MOVEMENT                        → eventType="motion"
     *   - eventType=AUDIO_ALARM                     → eventType="audio_alarm"
     *
     * @returns Parsed payload, or null if the event type is not recognised.
     */
    _parseNotification(raw: Record<string, unknown>): FcmEventPayload | null {
        const cameraId   = (raw["camera_id"]   ?? raw["cameraId"]   ?? "") as string;
        const cameraName = (raw["camera_name"] ?? raw["cameraName"] ?? "") as string;
        const timestamp  = (raw["timestamp"]   ?? "") as string;
        const imageUrl   = (raw["image_url"]   ?? raw["imageUrl"]   ?? "") as string;
        const eventId    = (raw["event_id"]    ?? raw["eventId"]    ?? "") as string;

        // Normalise raw Bosch event type (matches Python fcm.py PERSON upgrade logic)
        const rawType = ((raw["event_type"] ?? raw["eventType"] ?? "") as string).toUpperCase();
        const tags    = (raw["event_tags"] ?? raw["eventTags"] ?? []) as string[];

        let eventType: FcmEventPayload["eventType"];
        if (rawType === "MOVEMENT" && tags.includes("PERSON")) {
            eventType = "person";
        } else if (rawType === "MOVEMENT") {
            eventType = "motion";
        } else if (rawType === "AUDIO_ALARM") {
            eventType = "audio_alarm";
        } else if (rawType === "PERSON") {
            eventType = "person";
        } else {
            return null; // unknown type — caller should emit "error"
        }

        return {
            cameraId,
            cameraName,
            timestamp,
            eventType,
            imageUrl: imageUrl || undefined,
            eventId:  eventId  || undefined,
        };
    }
}
