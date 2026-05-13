/**
 * Unit tests for src/lib/fcm.ts
 *
 * Strategy: FcmListener currently ships as a stub (start() throws
 * FcmNotImplementedError — real FCM library pending API evaluation).
 * Tests verify:
 *   1. Stub lifecycle (start/stop/isHealthy/getFcmToken)
 *   2. CBS registration helper (_registerWithCbs) — success and error paths
 *   3. Notification parser (_parseNotification) — all event types + PERSON upgrade
 *   4. EventEmitter contract — "disconnect" on stop(), "error" propagation
 *
 * Framework: Mocha + Chai + Sinon
 * Mocking: stubAxiosSequence / stubAxiosError from helpers/axios-mock
 */

import { expect } from "chai";
import axios from "axios";
import sinon from "sinon";

import {
    FcmListener,
    FcmNotImplementedError,
    FcmCbsRegistrationError,
    FCM_SENDER_ID,
    FCM_IOS_APP_ID,
    CLOUD_API,
    type FcmEventPayload,
    type FcmCredentials,
} from "../../src/lib/fcm";

import {
    stubAxiosSequence,
    stubAxiosError,
    restoreAxios,
} from "./helpers/axios-mock";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Create a FcmListener with a fresh axios instance and a test bearer token. */
function makeListener(bearerToken = "test-bearer-token"): FcmListener {
    return new FcmListener(axios.create(), bearerToken);
}

// ── 1. Constants ──────────────────────────────────────────────────────────────

describe("FCM constants", () => {
    it("FCM_SENDER_ID matches Bosch Firebase sender ID", () => {
        expect(FCM_SENDER_ID).to.equal("404630424405");
    });

    it("FCM_IOS_APP_ID contains FCM_SENDER_ID", () => {
        expect(FCM_IOS_APP_ID).to.include(FCM_SENDER_ID);
    });

    it("CLOUD_API points to Bosch CBS", () => {
        expect(CLOUD_API).to.equal("https://residential.cbs.boschsecurity.com");
    });
});

// ── 2. Lifecycle — stub behaviour ─────────────────────────────────────────────

describe("FcmListener lifecycle (stub)", () => {
    it("start() throws FcmNotImplementedError (stub pending @aracna/fcm evaluation)", async () => {
        const listener = makeListener();
        try {
            await listener.start();
            expect.fail("should have thrown");
        } catch (err: unknown) {
            expect(err).to.be.instanceOf(FcmNotImplementedError);
            expect((err as FcmNotImplementedError).name).to.equal("FcmNotImplementedError");
            expect((err as FcmNotImplementedError).message).to.include("FCM push receiver not implemented");
        }
    });

    it("start() throws FcmNotImplementedError on second call (idempotent guard skipped in stub path)", async () => {
        const listener = makeListener();
        // Both calls should throw — we never reach _running=true in stub
        for (let i = 0; i < 2; i++) {
            try {
                await listener.start();
                expect.fail("should have thrown");
            } catch (err: unknown) {
                expect(err).to.be.instanceOf(FcmNotImplementedError);
            }
        }
    });

    it("getFcmToken() returns null before start()", () => {
        const listener = makeListener();
        expect(listener.getFcmToken()).to.be.null;
    });

    it("isHealthy() returns false before start()", () => {
        const listener = makeListener();
        expect(listener.isHealthy()).to.be.false;
    });

    it("stop() resolves without error when not running", async () => {
        const listener = makeListener();
        // Should not throw — idempotent
        await listener.stop();
        expect(listener.isHealthy()).to.be.false;
    });

    it("stop() emits 'disconnect' when listener was running", async () => {
        const listener = makeListener();
        // Manually set _running to simulate a running state (real impl would do this)
        (listener as unknown as { _running: boolean; _clientHandle: unknown })._running = true;
        (listener as unknown as { _running: boolean; _clientHandle: unknown })._clientHandle = {};

        const disconnectSpy = sinon.spy();
        listener.on("disconnect", disconnectSpy);

        await listener.stop();

        expect(disconnectSpy.calledOnce).to.be.true;
        expect(listener.isHealthy()).to.be.false;
    });

    it("isHealthy() returns true when _running=true and _clientHandle is set", () => {
        const listener = makeListener();
        const raw = listener as unknown as { _running: boolean; _clientHandle: unknown };
        raw._running = true;
        raw._clientHandle = { close: () => undefined };
        expect(listener.isHealthy()).to.be.true;
    });

    it("isHealthy() returns false when _running=true but _clientHandle is null", () => {
        const listener = makeListener();
        const raw = listener as unknown as { _running: boolean; _clientHandle: unknown };
        raw._running = true;
        raw._clientHandle = null;
        expect(listener.isHealthy()).to.be.false;
    });
});

// ── 3. CBS registration (_registerWithCbs) ────────────────────────────────────

describe("FcmListener._registerWithCbs()", () => {
    afterEach(() => {
        restoreAxios();
    });

    it("resolves on HTTP 204 success", async () => {
        stubAxiosSequence([{ status: 204, data: "" }]);
        const listener = makeListener();
        await listener._registerWithCbs("fcm-token-xyz", "ios");
        // No throw = pass
    });

    it("resolves on HTTP 200 success", async () => {
        stubAxiosSequence([{ status: 200, data: {} }]);
        const listener = makeListener();
        await listener._registerWithCbs("fcm-token-xyz", "android");
    });

    it("resolves on HTTP 500 sh:internal.error (duplicate registration)", async () => {
        stubAxiosSequence([{ status: 500, data: "sh:internal.error already registered" }]);
        const listener = makeListener();
        // Should NOT throw — Bosch returns 500 for duplicate, same as Python
        await listener._registerWithCbs("token-already-registered", "ios");
    });

    it("throws FcmCbsRegistrationError on HTTP 401 (invalid token)", async () => {
        stubAxiosSequence([{ status: 401, data: { error: "Unauthorized" } }]);
        const listener = makeListener();
        try {
            await listener._registerWithCbs("bad-token", "android");
            expect.fail("should have thrown");
        } catch (err: unknown) {
            expect(err).to.be.instanceOf(FcmCbsRegistrationError);
            expect((err as FcmCbsRegistrationError).httpStatus).to.equal(401);
            expect((err as FcmCbsRegistrationError).name).to.equal("FcmCbsRegistrationError");
        }
    });

    it("throws FcmCbsRegistrationError on HTTP 403 (forbidden)", async () => {
        stubAxiosSequence([{ status: 403, data: "Forbidden" }]);
        const listener = makeListener();
        try {
            await listener._registerWithCbs("token", "ios");
            expect.fail("should have thrown");
        } catch (err: unknown) {
            expect(err).to.be.instanceOf(FcmCbsRegistrationError);
            expect((err as FcmCbsRegistrationError).httpStatus).to.equal(403);
        }
    });

    it("throws generic Error on HTTP 500 without sh:internal.error (server crash)", async () => {
        stubAxiosSequence([{ status: 500, data: "Internal Server Error" }]);
        const listener = makeListener();
        try {
            await listener._registerWithCbs("token", "android");
            expect.fail("should have thrown");
        } catch (err: unknown) {
            // Must NOT be FcmCbsRegistrationError — it's a transient 5xx
            expect(err).to.not.be.instanceOf(FcmCbsRegistrationError);
            expect(err).to.be.instanceOf(Error);
            expect((err as Error).message).to.include("HTTP 500");
        }
    });

    it("sends IOS deviceType when mode='ios'", async () => {
        let capturedBody: unknown;
        const savedAdapter = axios.defaults.adapter;
        axios.defaults.adapter = (config) => {
            capturedBody = typeof config.data === "string" ? JSON.parse(config.data) : config.data;
            return Promise.resolve({ status: 204, data: "", headers: {}, statusText: "No Content", config, request: {} } as Parameters<typeof axios.defaults.adapter extends infer A ? A extends (...args: unknown[]) => unknown ? A : never : never>[0] extends undefined ? never : Parameters<NonNullable<typeof axios.defaults.adapter>>[0]);
        };
        try {
            const listener = makeListener();
            await listener._registerWithCbs("tok", "ios");
            expect((capturedBody as Record<string, unknown>)["deviceType"]).to.equal("IOS");
        } finally {
            axios.defaults.adapter = savedAdapter as typeof axios.defaults.adapter;
        }
    });

    it("sends ANDROID deviceType when mode='android'", async () => {
        let capturedBody: unknown;
        const savedAdapter = axios.defaults.adapter;
        axios.defaults.adapter = (config) => {
            capturedBody = typeof config.data === "string" ? JSON.parse(config.data) : config.data;
            return Promise.resolve({ status: 204, data: "", headers: {}, statusText: "No Content", config, request: {} } as Parameters<NonNullable<typeof axios.defaults.adapter>>[0]);
        };
        try {
            const listener = makeListener();
            await listener._registerWithCbs("tok", "android");
            expect((capturedBody as Record<string, unknown>)["deviceType"]).to.equal("ANDROID");
        } finally {
            axios.defaults.adapter = savedAdapter as typeof axios.defaults.adapter;
        }
    });
});

// ── 4. Notification parser (_parseNotification) ───────────────────────────────

describe("FcmListener._parseNotification()", () => {
    let listener: FcmListener;

    before(() => {
        listener = makeListener();
    });

    /** Build a minimal raw notification body */
    function makeRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
        return {
            camera_id:   "EF791764-A48D-4F00-9B32-EF04BEB0DDA0",
            camera_name: "Terrasse",
            timestamp:   "2026-05-12T14:30:00.000Z",
            event_type:  "MOVEMENT",
            event_tags:  [],
            image_url:   "https://example.boschsecurity.com/img.jpg",
            event_id:    "evt-abc123",
            ...overrides,
        };
    }

    it("parses MOVEMENT event → eventType='motion'", () => {
        const result = listener._parseNotification(makeRaw({ event_type: "MOVEMENT", event_tags: [] }));
        expect(result).to.not.be.null;
        expect(result!.eventType).to.equal("motion");
    });

    it("parses AUDIO_ALARM event → eventType='audio_alarm'", () => {
        const result = listener._parseNotification(makeRaw({ event_type: "AUDIO_ALARM", event_tags: [] }));
        expect(result).to.not.be.null;
        expect(result!.eventType).to.equal("audio_alarm");
    });

    it("parses MOVEMENT + PERSON tag → eventType='person' (Gen2 DualRadar upgrade)", () => {
        const result = listener._parseNotification(makeRaw({ event_type: "MOVEMENT", event_tags: ["PERSON"] }));
        expect(result).to.not.be.null;
        expect(result!.eventType).to.equal("person");
    });

    it("parses explicit PERSON event_type → eventType='person'", () => {
        const result = listener._parseNotification(makeRaw({ event_type: "PERSON", event_tags: [] }));
        expect(result).to.not.be.null;
        expect(result!.eventType).to.equal("person");
    });

    it("returns null for unknown event_type (e.g. CAMERA_ALARM — not in FcmEventPayload union)", () => {
        const result = listener._parseNotification(makeRaw({ event_type: "CAMERA_ALARM" }));
        expect(result).to.be.null;
    });

    it("returns null for empty event_type", () => {
        const result = listener._parseNotification(makeRaw({ event_type: "" }));
        expect(result).to.be.null;
    });

    it("fills cameraId, cameraName, timestamp, imageUrl, eventId from raw payload", () => {
        const result = listener._parseNotification(makeRaw());
        expect(result).to.not.be.null;
        expect(result!.cameraId).to.equal("EF791764-A48D-4F00-9B32-EF04BEB0DDA0");
        expect(result!.cameraName).to.equal("Terrasse");
        expect(result!.timestamp).to.equal("2026-05-12T14:30:00.000Z");
        expect(result!.imageUrl).to.equal("https://example.boschsecurity.com/img.jpg");
        expect(result!.eventId).to.equal("evt-abc123");
    });

    it("sets imageUrl=undefined when empty string", () => {
        const result = listener._parseNotification(makeRaw({ image_url: "" }));
        expect(result).to.not.be.null;
        expect(result!.imageUrl).to.be.undefined;
    });

    it("sets eventId=undefined when missing", () => {
        const raw = makeRaw();
        delete raw["event_id"];
        const result = listener._parseNotification(raw);
        expect(result).to.not.be.null;
        expect(result!.eventId).to.be.undefined;
    });

    it("accepts camelCase field names (cameraId, cameraName, eventType, eventTags)", () => {
        const result = listener._parseNotification({
            cameraId:   "cam-1",
            cameraName: "Indoor",
            timestamp:  "2026-01-01T00:00:00Z",
            eventType:  "AUDIO_ALARM",
            eventTags:  [],
        });
        expect(result).to.not.be.null;
        expect(result!.eventType).to.equal("audio_alarm");
        expect(result!.cameraId).to.equal("cam-1");
    });

    it("is case-insensitive for eventType (lowercase input)", () => {
        const result = listener._parseNotification(makeRaw({ event_type: "movement" }));
        expect(result).to.not.be.null;
        expect(result!.eventType).to.equal("motion");
    });
});

// ── 5. EventEmitter contract ──────────────────────────────────────────────────

describe("FcmListener EventEmitter contract", () => {
    it("is an EventEmitter (on/emit/off methods exist)", () => {
        const listener = makeListener();
        expect(listener.on).to.be.a("function");
        expect(listener.emit).to.be.a("function");
        expect(listener.off).to.be.a("function");
    });

    it("stop() on a running listener emits 'disconnect' exactly once", async () => {
        const listener = makeListener();
        const raw = listener as unknown as { _running: boolean; _clientHandle: unknown };
        raw._running = true;
        raw._clientHandle = {};

        const spy = sinon.spy();
        listener.on("disconnect", spy);
        await listener.stop();
        await listener.stop(); // second stop must NOT emit again

        expect(spy.callCount).to.equal(1);
    });

    it("can forward 'error' event without crashing (EventEmitter 'error' special handling)", () => {
        const listener = makeListener();
        // Register error handler to prevent uncaught exception crash
        const spy = sinon.spy();
        listener.on("error", spy);
        listener.emit("error", new Error("test error"));
        expect(spy.calledOnce).to.be.true;
        expect(spy.firstCall.args[0]).to.be.instanceOf(Error);
    });

    it("FcmNotImplementedError message includes fallback hint", async () => {
        const listener = makeListener();
        try {
            await listener.start();
        } catch (err: unknown) {
            expect((err as Error).message).to.include("Falling back to polling");
        }
    });
});
