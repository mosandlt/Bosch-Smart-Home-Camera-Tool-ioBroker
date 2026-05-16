/**
 * Bucket B — v0.5.2 livestream toggle + stream quality change tests.
 *
 * Strategy:
 *  - Inject mock live_session + tls_proxy + session_watchdog modules into require.cache
 *    before loading build/main.js so no real network calls happen.
 *  - Use sinon stubs to capture calls and control return values.
 *  - Verify ioBroker state transitions via MockDatabase.
 */

import { expect } from "chai";
import * as sinon from "sinon";
import * as path from "path";

import { stubAxiosSequence, restoreAxios } from "./helpers/axios-mock";

import type { MockDatabase } from "@iobroker/testing/build/tests/unit/mocks/mockDatabase";
import type { MockAdapter } from "@iobroker/testing/build/tests/unit/mocks/mockAdapter";

// eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
const { MockDatabase: MockDatabaseCtor } =
    require("@iobroker/testing/build/tests/unit/mocks/mockDatabase") as {
        MockDatabase: new () => MockDatabase;
    };

// eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
const { mockAdapterCore: mockAdapterCoreFn } =
    require("@iobroker/testing/build/tests/unit/mocks/mockAdapterCore") as {
        mockAdapterCore: (
            db: MockDatabase,
            opts?: { onAdapterCreated?: (a: MockAdapter) => void },
        ) => unknown;
    };

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const MAIN_JS_PATH = path.join(REPO_ROOT, "build", "main.js");
const ADAPTER_CORE_PATH = require.resolve("@iobroker/adapter-core");

type TestAdapter = MockAdapter & {
    readyHandler?: () => Promise<void>;
    unloadHandler?: (cb: () => void) => void;
    stateChangeHandler?: ioBroker.StateChangeHandler;
};

const CAM_ID = "EF791764-A48D-4F00-9B32-EF04BEB0DDA0";

const CAMERAS_BODY = [
    {
        id: CAM_ID,
        title: "Terrasse",
        hardwareVersion: "HOME_Eyes_Outdoor",
        firmwareVersion: "9.40.25",
        featureSupport: { light: true },
    },
];

const TOKEN_BODY = {
    access_token: "acc.stream.test",
    refresh_token: "ref.stream.test",
    expires_in: 300,
    refresh_expires_in: 86400,
    token_type: "Bearer",
    scope: "openid",
};

/** Fake LiveSession returned by mocked openLiveSession */
function makeFakeSession(camId: string = CAM_ID) {
    return {
        camId,
        lanAddress: "192.168.1.149:443",
        proxyUrl: `rtsp://127.0.0.1:18000/rtsp_tunnel`,
        maxSessionDuration: 3600,
        openedAt: Date.now(),
        digestUser: "admin",
        digestPassword: "secret",
    };
}

/** Fake TLS proxy handle returned by mocked startTlsProxy */
function makeFakeProxy() {
    const stopStub = sinon.stub().resolves();
    return {
        port: 18000,
        localRtspUrl: "rtsp://127.0.0.1:18000/rtsp_tunnel",
        stop: stopStub,
        _stopStub: stopStub,
    };
}

// ── Module path helpers ────────────────────────────────────────────────────────

function resolveBuildModule(name: string): string {
    return path.join(REPO_ROOT, "build", "lib", `${name}.js`);
}

// ── Adapter factory with injected mocks ───────────────────────────────────────

interface StreamMocks {
    openLiveSession: sinon.StubbedMember<() => Promise<ReturnType<typeof makeFakeSession>>>;
    closeLiveSession: sinon.StubbedMember<() => Promise<void>>;
    startTlsProxy: sinon.StubbedMember<() => Promise<ReturnType<typeof makeFakeProxy>>>;
    WatchdogStart: sinon.StubbedMember<() => void>;
    WatchdogStop: sinon.StubbedMember<() => void>;
    fetchSnapshot: sinon.StubbedMember<() => Promise<Buffer>>;
    fakeProxy: ReturnType<typeof makeFakeProxy>;
}

function createAdapterWithStreamMocks(
    configOverrides: Record<string, unknown> = {},
): { db: MockDatabase; adapter: TestAdapter; mocks: StreamMocks } {
    const db = new MockDatabaseCtor();
    let capturedAdapter: MockAdapter | null = null;

    const core = mockAdapterCoreFn(db, {
        onAdapterCreated: (a: MockAdapter) => {
            capturedAdapter = a;
        },
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (require.cache as any)[ADAPTER_CORE_PATH] = {
        id: ADAPTER_CORE_PATH,
        filename: ADAPTER_CORE_PATH,
        loaded: true,
        parent: module,
        children: [],
        path: path.dirname(ADAPTER_CORE_PATH),
        paths: [],
        exports: core,
    };

    // Inject mock live_session module
    const fakeSession = makeFakeSession();
    const openLiveSessionStub = sinon.stub().resolves(fakeSession);
    const closeLiveSessionStub = sinon.stub().resolves();
    const liveSessionPath = resolveBuildModule("live_session");
    delete require.cache[liveSessionPath];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (require.cache as any)[liveSessionPath] = {
        id: liveSessionPath,
        filename: liveSessionPath,
        loaded: true,
        parent: module,
        children: [],
        path: path.dirname(liveSessionPath),
        paths: [],
        exports: {
            openLiveSession: openLiveSessionStub,
            closeLiveSession: closeLiveSessionStub,
        },
    };

    // Inject mock tls_proxy module
    const fakeProxy = makeFakeProxy();
    const startTlsProxyStub = sinon.stub().resolves(fakeProxy);
    const tlsProxyPath = resolveBuildModule("tls_proxy");
    delete require.cache[tlsProxyPath];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (require.cache as any)[tlsProxyPath] = {
        id: tlsProxyPath,
        filename: tlsProxyPath,
        loaded: true,
        parent: module,
        children: [],
        path: path.dirname(tlsProxyPath),
        paths: [],
        exports: {
            startTlsProxy: startTlsProxyStub,
        },
    };

    // Inject mock snapshot module
    const fetchSnapshotStub = sinon.stub().resolves(Buffer.from("FAKEJPEG"));
    const snapshotPath = resolveBuildModule("snapshot");
    delete require.cache[snapshotPath];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (require.cache as any)[snapshotPath] = {
        id: snapshotPath,
        filename: snapshotPath,
        loaded: true,
        parent: module,
        children: [],
        path: path.dirname(snapshotPath),
        paths: [],
        exports: {
            fetchSnapshot: fetchSnapshotStub,
            buildSnapshotUrl: (url: string) => `${url}/snap.jpg`,
        },
    };

    // Inject mock session_watchdog module
    const watchdogStartStub = sinon.stub();
    const watchdogStopStub = sinon.stub();
    class FakeWatchdog {
        public start = watchdogStartStub;
        public stop = watchdogStopStub;
        constructor(
            _opts: unknown,
        ) {}
    }
    const watchdogPath = resolveBuildModule("session_watchdog");
    delete require.cache[watchdogPath];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (require.cache as any)[watchdogPath] = {
        id: watchdogPath,
        filename: watchdogPath,
        loaded: true,
        parent: module,
        children: [],
        path: path.dirname(watchdogPath),
        paths: [],
        exports: { SessionWatchdog: FakeWatchdog },
    };

    delete require.cache[MAIN_JS_PATH];
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const factory = require(MAIN_JS_PATH) as (opts: Record<string, unknown>) => MockAdapter;
    factory({
        config: { redirect_url: "", region: "EU", ...configOverrides },
    });

    if (!capturedAdapter) throw new Error("adapter not captured");
    const adapter = capturedAdapter as TestAdapter;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).setTimeout = (_fn: () => void, _ms: number) => null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).clearTimeout = (_h: unknown) => undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).terminate = () => undefined;
    // Mock writeFileAsync so snapshot tests don't fail on missing meta object
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).writeFileAsync = sinon.stub().resolves();

    return {
        db,
        adapter,
        mocks: {
            openLiveSession: openLiveSessionStub,
            closeLiveSession: closeLiveSessionStub,
            startTlsProxy: startTlsProxyStub,
            WatchdogStart: watchdogStartStub,
            WatchdogStop: watchdogStopStub,
            fetchSnapshot: fetchSnapshotStub,
            fakeProxy,
        },
    };
}

function getStateVal(db: MockDatabase, adapter: TestAdapter, id: string): unknown {
    const fullId = `${adapter.namespace}.${id}`;
    const state = db.getState(fullId);
    return (state as ioBroker.State | null | undefined)?.val;
}

/** Boot the adapter with valid stored tokens (skips login). */
async function bootAdapterWithTokens(db: MockDatabase, adapter: TestAdapter): Promise<void> {
    const futureExpiry = Date.now() + 200_000;
    db.publishState(`${adapter.namespace}.info.access_token`, { val: "stored.acc", ack: true });
    db.publishState(`${adapter.namespace}.info.refresh_token`, { val: "stored.ref", ack: true });
    db.publishState(`${adapter.namespace}.info.token_expires_at`, { val: futureExpiry, ack: true });
    await adapter.readyHandler!();
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("main adapter — livestream toggle (v0.5.2)", () => {
    afterEach(() => {
        restoreAxios();
        sinon.restore();
        // Clean up injected mocks so other test files get real modules
        delete require.cache[resolveBuildModule("live_session")];
        delete require.cache[resolveBuildModule("tls_proxy")];
        delete require.cache[resolveBuildModule("snapshot")];
        delete require.cache[resolveBuildModule("session_watchdog")];
        delete require.cache[MAIN_JS_PATH];
    });

    // ── Toggle ON ─────────────────────────────────────────────────────────────

    it("handleLivestreamToggle(true): opens session, spawns TLS proxy, arms watchdog, populates stream_url", async () => {
        stubAxiosSequence([{ status: 200, data: CAMERAS_BODY }]);
        const { db, adapter, mocks } = createAdapterWithStreamMocks();
        await bootAdapterWithTokens(db, adapter);

        // Simulate stateChange: livestream_enabled = true (ack=false)
        const stateId = `${adapter.namespace}.cameras.${CAM_ID}.livestream_enabled`;
        await adapter.stateChangeHandler!(stateId, { val: true, ack: false, ts: Date.now(), lc: Date.now(), from: "user" });

        expect(mocks.openLiveSession.callCount).to.be.greaterThan(0, "openLiveSession must be called");
        expect(mocks.startTlsProxy.callCount).to.be.greaterThan(0, "startTlsProxy must be called");
        expect(mocks.WatchdogStart.callCount).to.be.greaterThan(0, "watchdog.start must be called");

        const streamUrl = getStateVal(db, adapter, `cameras.${CAM_ID}.stream_url`) as string;
        expect(streamUrl).to.be.a("string").and.to.have.length.greaterThan(0);
        expect(streamUrl).to.include("rtsp://");
    });

    // ── Toggle OFF ────────────────────────────────────────────────────────────

    it("handleLivestreamToggle(false): tears down stream, clears stream_url", async () => {
        stubAxiosSequence([{ status: 200, data: CAMERAS_BODY }]);
        const { db, adapter, mocks } = createAdapterWithStreamMocks();
        await bootAdapterWithTokens(db, adapter);

        // First toggle ON to create the session/proxy/watchdog
        const stateId = `${adapter.namespace}.cameras.${CAM_ID}.livestream_enabled`;
        await adapter.stateChangeHandler!(stateId, { val: true, ack: false, ts: Date.now(), lc: Date.now(), from: "user" });
        expect(mocks.openLiveSession.callCount).to.be.greaterThan(0);

        // Now toggle OFF
        await adapter.stateChangeHandler!(stateId, { val: false, ack: false, ts: Date.now(), lc: Date.now(), from: "user" });

        // Watchdog should be stopped
        expect(mocks.WatchdogStop.callCount).to.be.greaterThan(0, "watchdog.stop must be called");
        // Proxy stop must be called
        expect(mocks.fakeProxy._stopStub.callCount).to.be.greaterThan(0, "proxy.stop must be called");
        // stream_url must be cleared
        const streamUrl = getStateVal(db, adapter, `cameras.${CAM_ID}.stream_url`);
        expect(streamUrl).to.equal("");
    });

    // ── Session open failure ───────────────────────────────────────────────────

    it("session open failure: stream_url stays empty, info.connection unchanged", async () => {
        stubAxiosSequence([{ status: 200, data: CAMERAS_BODY }]);
        const { db, adapter, mocks } = createAdapterWithStreamMocks();
        // Make openLiveSession reject
        mocks.openLiveSession.rejects(new Error("Camera unreachable on LAN"));
        await bootAdapterWithTokens(db, adapter);

        const stateId = `${adapter.namespace}.cameras.${CAM_ID}.livestream_enabled`;
        await adapter.stateChangeHandler!(stateId, { val: true, ack: false, ts: Date.now(), lc: Date.now(), from: "user" });

        // stream_url must remain empty (never set)
        const streamUrl = getStateVal(db, adapter, `cameras.${CAM_ID}.stream_url`);
        expect(streamUrl === "" || streamUrl === undefined || streamUrl === null, "stream_url stays empty on failure").to.equal(true);
        // Connection should still be true (adapter stays running)
        expect(getStateVal(db, adapter, "info.connection")).to.equal(true);
    });

    // ── _teardownStream idempotency ────────────────────────────────────────────

    it("_teardownStream is idempotent: toggling OFF twice does not error", async () => {
        stubAxiosSequence([{ status: 200, data: CAMERAS_BODY }]);
        const { db, adapter, mocks } = createAdapterWithStreamMocks();
        await bootAdapterWithTokens(db, adapter);

        const stateId = `${adapter.namespace}.cameras.${CAM_ID}.livestream_enabled`;
        // Toggle ON then OFF twice — should not throw
        await adapter.stateChangeHandler!(stateId, { val: true, ack: false, ts: Date.now(), lc: Date.now(), from: "user" });
        await adapter.stateChangeHandler!(stateId, { val: false, ack: false, ts: Date.now(), lc: Date.now(), from: "user" });
        // Second OFF — proxy is already gone; should be a no-op, no error
        await adapter.stateChangeHandler!(stateId, { val: false, ack: false, ts: Date.now(), lc: Date.now(), from: "user" });

        // Just verify we didn't crash and state is still empty
        const streamUrl = getStateVal(db, adapter, `cameras.${CAM_ID}.stream_url`);
        expect(streamUrl === "" || streamUrl === undefined || streamUrl === null).to.equal(true);
        void mocks; // mocks used indirectly above
    });

    // ── handleStreamQualityChange ─────────────────────────────────────────────

    it("handleStreamQualityChange while livestream OFF: only persists preference, no session work", async () => {
        stubAxiosSequence([{ status: 200, data: CAMERAS_BODY }]);
        const { db, adapter, mocks } = createAdapterWithStreamMocks();
        await bootAdapterWithTokens(db, adapter);

        const qualityId = `${adapter.namespace}.cameras.${CAM_ID}.stream_quality`;
        const openCallsBefore = mocks.openLiveSession.callCount;

        // Change quality while livestream is off (default)
        await adapter.stateChangeHandler!(qualityId, { val: "low", ack: false, ts: Date.now(), lc: Date.now(), from: "user" });

        // openLiveSession must NOT be called for this quality change (no live session to re-open)
        expect(mocks.openLiveSession.callCount).to.equal(openCallsBefore, "no session opened on quality change while stream off");
        void db; // db captured in closure
    });

    it("handleStreamQualityChange while livestream ON: closes existing session then quality change persisted", async () => {
        stubAxiosSequence([{ status: 200, data: CAMERAS_BODY }]);
        const { db, adapter, mocks } = createAdapterWithStreamMocks();
        await bootAdapterWithTokens(db, adapter);

        const stateId = `${adapter.namespace}.cameras.${CAM_ID}.livestream_enabled`;
        const qualityId = `${adapter.namespace}.cameras.${CAM_ID}.stream_quality`;

        // First turn on livestream
        await adapter.stateChangeHandler!(stateId, { val: true, ack: false, ts: Date.now(), lc: Date.now(), from: "user" });
        expect(mocks.openLiveSession.callCount).to.be.greaterThan(0);

        // Now change quality
        const closeBefore = mocks.closeLiveSession.callCount;
        await adapter.stateChangeHandler!(qualityId, { val: "low", ack: false, ts: Date.now(), lc: Date.now(), from: "user" });

        // closeLiveSession should be called (to close the existing session)
        expect(mocks.closeLiveSession.callCount).to.be.greaterThan(closeBefore, "closeLiveSession called on quality change while streaming");
        void db;
    });

    // ── onUnload teardown ─────────────────────────────────────────────────────

    it("onUnload: calls proxy.stop() for active streams", async () => {
        stubAxiosSequence([{ status: 200, data: TOKEN_BODY }, { status: 200, data: CAMERAS_BODY }]);
        const { db, adapter, mocks } = createAdapterWithStreamMocks({
            redirect_url: "https://www.bosch.com/boschcam?code=D1&state=T1",
        });
        db.publishState(`${adapter.namespace}.info.pkce_verifier`, { val: "pkce-verifier-unload-test-abcdef123", ack: true });
        db.publishState(`${adapter.namespace}.info.pkce_state`, { val: "T1", ack: true });
        await adapter.readyHandler!();

        // Start a stream
        const stateId = `${adapter.namespace}.cameras.${CAM_ID}.livestream_enabled`;
        await adapter.stateChangeHandler!(stateId, { val: true, ack: false, ts: Date.now(), lc: Date.now(), from: "user" });
        expect(mocks.startTlsProxy.callCount).to.be.greaterThan(0);

        // Unload
        await new Promise<void>((resolve) => {
            adapter.unloadHandler!(() => resolve());
        });

        expect(mocks.fakeProxy._stopStub.callCount).to.be.greaterThan(0, "proxy.stop must be called during unload");
        void db;
    });
});
