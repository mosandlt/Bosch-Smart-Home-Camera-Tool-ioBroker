/**
 * Unit tests for src/lib/fcm.ts — real @aracna/fcm implementation.
 *
 * Strategy: FcmListener now ships with a real FCM implementation backed by
 * @aracna/fcm (MTalk/MCS protocol). Tests verify:
 *   1. Constants — sender ID, app IDs, cloud API
 *   2. Lifecycle — start/stop/isHealthy/getFcmToken (registerToFCM + FcmClient mocked via DI)
 *   3. CBS registration (_registerWithCbs) — all HTTP status paths
 *   4. Notification parser (_parseNotification) — all event types + PERSON upgrade
 *   5. EventEmitter contract — "push", "registered", "disconnect", "error"
 *   6. Mode selection — ios/android/auto fall-back logic
 *   7. Credential persistence — savedCredentials.raw reused across restarts
 *
 * Framework: Mocha + Chai + Sinon
 *
 * Mocking strategy: @aracna/fcm exports are sealed (non-configurable ES module
 * exports) — sinon.stub(module, "fn") fails with "non-configurable and non-writable".
 * Instead, FcmListener accepts a `deps` injection parameter (4th constructor arg)
 * with the three @aracna/fcm functions. Tests pass sinon stubs via deps.
 */

import { expect } from "chai";
import axios from "axios";
import sinon from "sinon";
import type { ECDH } from "crypto";

import {
    FcmListener,
    FcmCbsRegistrationError,
    FcmRegistrationError,
    FCM_SENDER_ID,
    FCM_IOS_APP_ID,
    FCM_ANDROID_APP_ID,
    CLOUD_API,
    type FcmEventPayload,
    type FcmCredentials,
    type FcmRawCredentials,
    type FcmDeps,
} from "../../src/lib/fcm";

import {
    stubAxiosSequence,
    restoreAxios,
} from "./helpers/axios-mock";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Minimal fake ECDH-like object returned by stubbed createFcmECDH */
function makeFakeEcdh(privateKey = Buffer.alloc(32, 0xab), publicKey = Buffer.alloc(65, 0x04)) {
    return {
        getPublicKey: () => publicKey,
        getPrivateKey: () => privateKey,
        setPrivateKey: sinon.stub(),
    } as unknown as ECDH;
}

/** Minimal fake FcmRegistration returned by stubbed registerToFCM */
function makeFakeReg() {
    return {
        acg: { id: BigInt("4658368044210161110"), securityToken: BigInt("6632001525114872722") },
        token: "fake-fcm-token-xyz",
    };
}

/** Minimal fake FcmClient with connect/disconnect/on compatible with FcmClient interface */
function makeFakeClient(connectResult: Error | undefined = undefined) {
    const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
    const client = {
        connect: sinon.stub().resolves(connectResult),
        disconnect: sinon.stub().resolves(undefined),
        on: (event: string, cb: (...args: unknown[]) => void) => {
            (handlers[event] ??= []).push(cb);
        },
        _emit: (event: string, ...args: unknown[]) => {
            for (const cb of handlers[event] ?? []) cb(...args);
        },
    };
    return client;
}

/**
 * Build a FcmDeps object with all dependencies stubbed.
 * Pass the overrides you care about; the rest default to "success" stubs.
 */
function makeDeps(overrides: Partial<{
    registerResult: ReturnType<typeof makeFakeReg> | Error;
    fakeClient: ReturnType<typeof makeFakeClient>;
}> = {}): { deps: FcmDeps; fakeClient: ReturnType<typeof makeFakeClient> } {
    const fakeClient = overrides.fakeClient ?? makeFakeClient();
    const registerResult = overrides.registerResult ?? makeFakeReg();

    const deps: FcmDeps = {
        registerToFCM: sinon.stub().resolves(registerResult) as unknown as FcmDeps["registerToFCM"],
        createFcmECDH: sinon.stub().returns(makeFakeEcdh()) as unknown as FcmDeps["createFcmECDH"],
        generateFcmAuthSecret: sinon.stub().returns(Buffer.alloc(16, 0x11)) as unknown as FcmDeps["generateFcmAuthSecret"],
        FcmClient: sinon.stub().returns(fakeClient) as unknown as FcmDeps["FcmClient"],
    };
    return { deps, fakeClient };
}

/** Create a FcmListener with injected stub deps and a fresh axios instance. */
function makeListener(
    bearerToken = "test-bearer-token",
    options?: ConstructorParameters<typeof FcmListener>[2],
    deps?: Partial<FcmDeps>,
): FcmListener {
    return new FcmListener(axios.create(), bearerToken, options, deps);
}

// ── 1. Constants ──────────────────────────────────────────────────────────────

describe("FCM constants", () => {
    it("FCM_SENDER_ID matches Bosch Firebase sender ID", () => {
        expect(FCM_SENDER_ID).to.equal("404630424405");
    });

    it("FCM_IOS_APP_ID contains FCM_SENDER_ID", () => {
        expect(FCM_IOS_APP_ID).to.include(FCM_SENDER_ID);
    });

    it("FCM_ANDROID_APP_ID contains FCM_SENDER_ID", () => {
        expect(FCM_ANDROID_APP_ID).to.include(FCM_SENDER_ID);
    });

    it("CLOUD_API points to Bosch CBS", () => {
        expect(CLOUD_API).to.equal("https://residential.cbs.boschsecurity.com");
    });
});

// ── 2. Lifecycle — real impl (deps injected) ──────────────────────────────────

describe("FcmListener lifecycle (real impl, injected deps)", () => {
    afterEach(() => {
        restoreAxios();
    });

    it("start() registers with FCM, registers with CBS, and sets _running=true (ios mode)", async () => {
        const { deps } = makeDeps();
        stubAxiosSequence([{ status: 204, data: "" }]); // CBS registration
        const listener = makeListener("tok", { mode: "ios" }, deps);
        await listener.start();

        expect(listener.isHealthy()).to.be.true;
        expect(listener.getFcmToken()).to.equal("fake-fcm-token-xyz");
        expect((deps.registerToFCM as sinon.SinonStub).calledOnce).to.be.true;
    });

    it("start() with mode='android' calls registerToFCM with Android app ID", async () => {
        const { deps } = makeDeps();
        stubAxiosSequence([{ status: 204, data: "" }]);
        const listener = makeListener("tok", { mode: "android" }, deps);
        await listener.start();

        const registerStub = deps.registerToFCM as sinon.SinonStub;
        const config = registerStub.firstCall.args[0] as { firebase: { appID: string } };
        expect(config.firebase.appID).to.equal(FCM_ANDROID_APP_ID);
    });

    it("start() with mode='ios' calls registerToFCM with iOS app ID", async () => {
        const { deps } = makeDeps();
        stubAxiosSequence([{ status: 204, data: "" }]);
        const listener = makeListener("tok", { mode: "ios" }, deps);
        await listener.start();

        const registerStub = deps.registerToFCM as sinon.SinonStub;
        const config = registerStub.firstCall.args[0] as { firebase: { appID: string } };
        expect(config.firebase.appID).to.equal(FCM_IOS_APP_ID);
    });

    it("start() is idempotent — second call does nothing when already running", async () => {
        const { deps } = makeDeps();
        stubAxiosSequence([{ status: 204, data: "" }]);
        const listener = makeListener("tok", { mode: "ios" }, deps);
        await listener.start();
        await listener.start(); // second call must be no-op

        expect((deps.registerToFCM as sinon.SinonStub).callCount).to.equal(1);
    });

    it("start() emits 'registered' with FcmCredentials", async () => {
        const { deps } = makeDeps();
        stubAxiosSequence([{ status: 204, data: "" }]);
        const listener = makeListener("tok", { mode: "ios" }, deps);

        const registeredSpy = sinon.spy();
        listener.on("registered", registeredSpy);

        await listener.start();

        expect(registeredSpy.calledOnce).to.be.true;
        const creds = registeredSpy.firstCall.args[0] as FcmCredentials;
        expect(creds.fcmToken).to.equal("fake-fcm-token-xyz");
        expect(creds.mode).to.equal("ios");
        expect(creds.raw).to.have.property("acgId");
        expect(creds.raw).to.have.property("acgSecurityToken");
        expect(creds.raw).to.have.property("authSecret");
        expect(creds.raw).to.have.property("ecdhPrivateKey");
        expect(creds.raw).to.have.property("ecdhPublicKey");
    });

    it("stop() sets _running=false and emits 'disconnect'", async () => {
        const { deps } = makeDeps();
        stubAxiosSequence([{ status: 204, data: "" }]);
        const listener = makeListener("tok", { mode: "ios" }, deps);
        await listener.start();

        const spy = sinon.spy();
        listener.on("disconnect", spy);
        await listener.stop();

        expect(spy.calledOnce).to.be.true;
        expect(listener.isHealthy()).to.be.false;
        expect(listener.getFcmToken()).to.be.null;
    });

    it("stop() is idempotent — does not emit 'disconnect' twice", async () => {
        const { deps } = makeDeps();
        stubAxiosSequence([{ status: 204, data: "" }]);
        const listener = makeListener("tok", { mode: "ios" }, deps);
        await listener.start();

        const spy = sinon.spy();
        listener.on("disconnect", spy);

        await listener.stop();
        await listener.stop(); // second stop must not emit

        expect(spy.callCount).to.equal(1);
    });

    it("stop() on a non-running listener does nothing", async () => {
        const { deps } = makeDeps();
        const listener = makeListener("tok", { mode: "ios" }, deps);
        const spy = sinon.spy();
        listener.on("disconnect", spy);
        await listener.stop();
        expect(spy.callCount).to.equal(0);
    });

    it("getFcmToken() returns null before start()", () => {
        const listener = makeListener();
        expect(listener.getFcmToken()).to.be.null;
    });

    it("isHealthy() returns false before start()", () => {
        const listener = makeListener();
        expect(listener.isHealthy()).to.be.false;
    });

    it("start() throws FcmRegistrationError when registerToFCM returns Error (mode=ios)", async () => {
        const { deps } = makeDeps({ registerResult: new Error("Google API rejected") });
        const listener = makeListener("tok", { mode: "ios" }, deps);

        try {
            await listener.start();
            expect.fail("should have thrown");
        } catch (err: unknown) {
            expect(err).to.be.instanceOf(FcmRegistrationError);
        }
    });

    it("start() mode='auto' falls back to android when ios fails", async () => {
        // iOS registration fails, android succeeds
        const registerStub = sinon.stub();
        registerStub.onFirstCall().resolves(new Error("iOS reg failed"));
        registerStub.onSecondCall().resolves(makeFakeReg());

        const fakeClient = makeFakeClient();
        const deps: FcmDeps = {
            registerToFCM: registerStub as unknown as FcmDeps["registerToFCM"],
            createFcmECDH: sinon.stub().returns(makeFakeEcdh()) as unknown as FcmDeps["createFcmECDH"],
            generateFcmAuthSecret: sinon.stub().returns(Buffer.alloc(16, 0x11)) as unknown as FcmDeps["generateFcmAuthSecret"],
            FcmClient: sinon.stub().returns(fakeClient) as unknown as FcmDeps["FcmClient"],
        };

        stubAxiosSequence([{ status: 204, data: "" }]); // CBS for android
        const listener = makeListener("tok", { mode: "auto" }, deps);
        await listener.start();

        expect(registerStub.callCount).to.equal(2);
        expect(listener.isHealthy()).to.be.true;
    });

    it("start() mode='auto' throws FcmRegistrationError when both ios and android fail", async () => {
        const { deps } = makeDeps({ registerResult: new Error("all modes failed") });
        const listener = makeListener("tok", { mode: "auto" }, deps);

        try {
            await listener.start();
            expect.fail("should have thrown");
        } catch (err: unknown) {
            expect(err).to.be.instanceOf(FcmRegistrationError);
        }
    });
});

// ── 3. FCM client events ──────────────────────────────────────────────────────

describe("FcmListener — push event forwarding", () => {
    afterEach(() => {
        restoreAxios();
    });

    it("emits 'push' when FcmClient fires 'message-data' (silent wake-up)", async () => {
        const fakeClient = makeFakeClient();
        const { deps } = makeDeps({ fakeClient });
        stubAxiosSequence([{ status: 204, data: "" }]);
        const listener = makeListener("tok", { mode: "ios" }, deps);
        const pushSpy = sinon.spy();
        listener.on("push", pushSpy);

        await listener.start();

        // Simulate a silent Bosch push (no data dict)
        fakeClient._emit("message-data", { data: {}, from: "404630424405", fcmMessageId: "msg1", priority: "high" });

        expect(pushSpy.calledOnce).to.be.true;
    });

    it("emits 'motion' when push data contains MOVEMENT event type", async () => {
        const fakeClient = makeFakeClient();
        const { deps } = makeDeps({ fakeClient });
        stubAxiosSequence([{ status: 204, data: "" }]);
        const listener = makeListener("tok", { mode: "ios" }, deps);
        const motionSpy = sinon.spy();
        listener.on("motion", motionSpy);

        await listener.start();

        fakeClient._emit("message-data", {
            data: {
                camera_id: "EF791764",
                camera_name: "Terrasse",
                timestamp: "2026-05-13T10:00:00Z",
                event_type: "MOVEMENT",
                event_tags: [],
            },
            from: "404630424405",
            fcmMessageId: "msg2",
            priority: "high",
        });

        expect(motionSpy.calledOnce).to.be.true;
    });

    it("emits 'disconnect' when FcmClient fires 'close'", async () => {
        const fakeClient = makeFakeClient();
        const { deps } = makeDeps({ fakeClient });
        stubAxiosSequence([{ status: 204, data: "" }]);
        const listener = makeListener("tok", { mode: "ios" }, deps);
        const disconnectSpy = sinon.spy();
        listener.on("disconnect", disconnectSpy);

        await listener.start();
        fakeClient._emit("close");

        expect(disconnectSpy.calledOnce).to.be.true;
        expect(listener.isHealthy()).to.be.false;
    });
});

// ── 4. CBS registration (_registerWithCbs) ────────────────────────────────────

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

    it("resolves on HTTP 201 success", async () => {
        stubAxiosSequence([{ status: 201, data: {} }]);
        const listener = makeListener();
        await listener._registerWithCbs("fcm-token-xyz", "ios");
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
            return Promise.resolve({ status: 204, data: "", headers: {}, statusText: "No Content", config, request: {} } as Parameters<NonNullable<typeof axios.defaults.adapter>>[0]);
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

// ── 5. Notification parser (_parseNotification) ───────────────────────────────

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
            timestamp:   "2026-05-13T14:30:00.000Z",
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
        expect(result!.timestamp).to.equal("2026-05-13T14:30:00.000Z");
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

// ── 6. EventEmitter contract ──────────────────────────────────────────────────

describe("FcmListener EventEmitter contract", () => {
    it("is an EventEmitter (on/emit/off methods exist)", () => {
        const listener = makeListener();
        expect(listener.on).to.be.a("function");
        expect(listener.emit).to.be.a("function");
        expect(listener.off).to.be.a("function");
    });

    it("can forward 'error' event without crashing (EventEmitter 'error' special handling)", () => {
        const listener = makeListener();
        const spy = sinon.spy();
        listener.on("error", spy);
        listener.emit("error", new Error("test error"));
        expect(spy.calledOnce).to.be.true;
        expect(spy.firstCall.args[0]).to.be.instanceOf(Error);
    });

    it("FcmRegistrationError has correct name and message", () => {
        const err = new FcmRegistrationError("FCM: registration failed for mode 'ios'");
        expect(err.name).to.equal("FcmRegistrationError");
        expect(err.message).to.include("registration failed");
    });

    it("FcmCbsRegistrationError carries httpStatus property", () => {
        const err = new FcmCbsRegistrationError(403, "CBS /v11/devices HTTP 403: Forbidden");
        expect(err.name).to.equal("FcmCbsRegistrationError");
        expect(err.httpStatus).to.equal(403);
    });
});

// ── 7. Credential persistence ─────────────────────────────────────────────────

describe("FcmListener — credential persistence (savedCredentials)", () => {
    afterEach(() => {
        restoreAxios();
    });

    it("start() with savedCredentials.raw passes acg IDs to registerToFCM", async () => {
        const fakeEcdh = makeFakeEcdh();
        const registerStub = sinon.stub().resolves(makeFakeReg());
        const deps: FcmDeps = {
            registerToFCM: registerStub as unknown as FcmDeps["registerToFCM"],
            createFcmECDH: sinon.stub().returns(fakeEcdh) as unknown as FcmDeps["createFcmECDH"],
            generateFcmAuthSecret: sinon.stub().returns(Buffer.alloc(16, 0x11)) as unknown as FcmDeps["generateFcmAuthSecret"],
            FcmClient: sinon.stub().returns(makeFakeClient()) as unknown as FcmDeps["FcmClient"],
        };

        stubAxiosSequence([{ status: 204, data: "" }]);

        const savedRaw: FcmRawCredentials = {
            acgId: "4658368044210161110",
            acgSecurityToken: "6632001525114872722",
            authSecret: Array.from(Buffer.alloc(16, 0x22)),
            ecdhPrivateKey: Array.from(Buffer.alloc(32, 0xcc)),
            ecdhPublicKey: Array.from(Buffer.alloc(65, 0x04)),
            mode: "ios",
        };
        const savedCreds: FcmCredentials = {
            fcmToken: "old-token",
            mode: "ios",
            raw: savedRaw,
        };

        const listener = makeListener("tok", { mode: "ios", savedCredentials: savedCreds }, deps);
        await listener.start();

        const config = registerStub.firstCall.args[0] as { acg?: { id: bigint; securityToken: bigint } };
        expect(config.acg?.id).to.equal(BigInt("4658368044210161110"));
        expect(config.acg?.securityToken).to.equal(BigInt("6632001525114872722"));
    });

    it("start() without savedCredentials calls generateFcmAuthSecret", async () => {
        const generateStub = sinon.stub().returns(Buffer.alloc(16, 0x11));
        const deps: FcmDeps = {
            registerToFCM: sinon.stub().resolves(makeFakeReg()) as unknown as FcmDeps["registerToFCM"],
            createFcmECDH: sinon.stub().returns(makeFakeEcdh()) as unknown as FcmDeps["createFcmECDH"],
            generateFcmAuthSecret: generateStub as unknown as FcmDeps["generateFcmAuthSecret"],
            FcmClient: sinon.stub().returns(makeFakeClient()) as unknown as FcmDeps["FcmClient"],
        };

        stubAxiosSequence([{ status: 204, data: "" }]);
        const listener = makeListener("tok", { mode: "ios" }, deps);
        await listener.start();

        expect(generateStub.calledOnce).to.be.true;
    });

    it("registered credentials contain serialisable acgId, acgSecurityToken, authSecret arrays", async () => {
        const { deps } = makeDeps();
        stubAxiosSequence([{ status: 204, data: "" }]);
        const listener = makeListener("tok", { mode: "android" }, deps);

        let emittedCreds: FcmCredentials | undefined;
        listener.on("registered", (c: FcmCredentials) => { emittedCreds = c; });

        await listener.start();

        expect(emittedCreds).to.not.be.undefined;
        // Verify JSON-serialisable
        const json = JSON.stringify(emittedCreds!.raw);
        const parsed = JSON.parse(json) as FcmRawCredentials;
        expect(parsed.acgId).to.be.a("string");
        expect(parsed.acgSecurityToken).to.be.a("string");
        expect(parsed.authSecret).to.be.an("array");
        expect(parsed.ecdhPrivateKey).to.be.an("array");
        expect(parsed.ecdhPublicKey).to.be.an("array");
    });
});
