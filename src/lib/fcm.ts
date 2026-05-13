/**
 * FCM (Firebase Cloud Messaging) push receiver for Bosch Smart Home Camera.
 *
 * Port of the Python fcm.py → TypeScript EventEmitter pattern.
 *
 * ## Library research (2026-05-13)
 *
 * The Python HA integration uses `firebase-messaging` (sdb9696) which speaks the
 * MTalk/MCS protocol to `mtalk.google.com:5228`. It registers with:
 *   - project_id  (Firebase project, e.g. "bosch-smart-cameras")
 *   - app_id      (Firebase app ID, e.g. "1:404630424405:android:…")
 *   - api_key     (Firebase restricted browser key)
 *   - messaging_sender_id  ("404630424405")
 *
 * Node.js options evaluated:
 *   A) push-receiver@2.1.1 — uses only `senderId` (no project_id/app_id/api_key).
 *      Internally calls the old `fcm.googleapis.com/fcm/connect/subscribe` v1 API
 *      via `request-promise` (deprecated). Credential model is incompatible with
 *      the Bosch FCM config structure. Last published 2022-06-25.
 *   B) @aracna/fcm@1.0.32 — described as "more recent/robust version of push-receiver";
 *      last published 2026-03-07. GitHub README and official docs site returned 404/403
 *      for all fetch attempts. API cannot be verified without installing the package.
 *   C) Manual MTalk — too complex, skip.
 *
 * Decision: **STUB implementation** — exports the full FcmListener API, but
 * `start()` throws `FcmNotImplementedError` so the coordinator can wire it up now
 * and the adapter compiles cleanly. Real FCM receive will be added once @aracna/fcm
 * is confirmed API-compatible with Bosch's project_id/app_id/api_key config.
 *
 * Blocked by: evaluating @aracna/fcm API surface against Bosch FCM config.
 * Track: https://github.com/mosandlt/ioBroker.bosch-smart-home-camera/issues
 *
 * Constants mirrored from Python fcm.py:
 *   FCM_SENDER_ID = "404630424405"
 *   FCM_IOS_APP_ID = "1:404630424405:ios:715aae2570e39faad9bddc"
 */

import { EventEmitter } from "events";
import type { AxiosInstance } from "axios";

// ── Constants (from Python fcm.py) ───────────────────────────────────────────

export const CLOUD_API = "https://residential.cbs.boschsecurity.com";
export const FCM_SENDER_ID = "404630424405";
export const FCM_IOS_APP_ID = `1:${FCM_SENDER_ID}:ios:715aae2570e39faad9bddc`;

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
 * FCM credentials returned after successful registration.
 * Intended to be persisted by the caller across restarts (same pattern as
 * `saved_fcm_creds` in Python HA integration).
 */
export interface FcmCredentials {
    fcmToken: string;
    /** Push mode actually used ("ios" | "android") */
    mode: "ios" | "android";
    /** Raw credential blob from the underlying FCM library (opaque) */
    raw?: unknown;
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
 * Thrown by start() when the FCM push receiver is not yet implemented.
 * The adapter compiles and runs; only real-time push is unavailable.
 * The coordinator should fall back to polling when it catches this error.
 */
export class FcmNotImplementedError extends Error {
    constructor() {
        super(
            "FCM push receiver not implemented yet — " +
            "pending evaluation of @aracna/fcm API against Bosch FCM config " +
            "(project_id/app_id/api_key). Falling back to polling.",
        );
        this.name = "FcmNotImplementedError";
    }
}

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

// ── FcmListener ───────────────────────────────────────────────────────────────

/**
 * FCM push-notification listener for Bosch Smart Home Camera events.
 *
 * Events emitted:
 *   "motion"      → FcmEventPayload
 *   "audio_alarm" → FcmEventPayload
 *   "person"      → FcmEventPayload
 *   "registered"  → FcmCredentials
 *   "error"       → Error
 *   "disconnect"  → void
 *
 * Usage:
 * ```typescript
 * const fcm = new FcmListener(httpClient, bearerToken);
 * fcm.on("motion", (payload) => { ... });
 * fcm.on("person", (payload) => { ... });
 * try {
 *   await fcm.start();
 * } catch (err) {
 *   if (err instanceof FcmNotImplementedError) {
 *     // FCM not available — fall back to polling
 *   }
 * }
 * ```
 */
export class FcmListener extends EventEmitter {
    private readonly _httpClient: AxiosInstance;
    private readonly _bearerToken: string;
    private readonly _options: FcmListenerOptions;

    private _fcmToken: string | null = null;
    private _running = false;
    /** Internal handle returned by the underlying FCM library (opaque) */
    private _clientHandle: unknown = null;

    constructor(
        httpClient: AxiosInstance,
        bearerToken: string,
        options?: FcmListenerOptions,
    ) {
        super();
        this._httpClient = httpClient;
        this._bearerToken = bearerToken;
        this._options = options ?? {};
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /**
     * Register with FCM and start listening for push notifications.
     *
     * Step 1: Register this adapter instance with Google FCM → get device token.
     * Step 2: Register the token with Bosch CBS (`POST /v11/devices`).
     * Step 3: Start the long-lived FCM connection and emit events.
     *
     * @throws FcmNotImplementedError  Always — stub pending real FCM library.
     * @throws FcmCbsRegistrationError If Bosch CBS rejects the token (HTTP 4xx).
     */
    async start(): Promise<void> {
        if (this._running) {
            return;
        }
        // STUB: real FCM library not yet wired. Throw so the coordinator can
        // detect the condition and fall back to polling gracefully.
        throw new FcmNotImplementedError();
    }

    /**
     * Stop the listener cleanly. Closes the MTalk connection and sets state to
     * stopped. Safe to call multiple times (idempotent).
     */
    async stop(): Promise<void> {
        if (!this._running) {
            return;
        }
        this._running = false;
        this._clientHandle = null;
        this.emit("disconnect");
    }

    /**
     * Returns the current FCM device token, or null if not yet registered.
     * Can be used for status display in the adapter UI.
     */
    getFcmToken(): string | null {
        return this._fcmToken;
    }

    /**
     * Returns true when the FCM connection is active and receiving pushes.
     */
    isHealthy(): boolean {
        return this._running && this._clientHandle !== null;
    }

    // ── Internal helpers (used by real implementation when @aracna/fcm lands) ─

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
