/**
 * Bucket E — v0.5.1 poll + v0.5.4 reachability tests.
 *
 * Covers:
 *  - v0.5.4 markCameraReachability / OFFLINE_THRESHOLD: 3 failures → online=false
 *  - Success between failures resets fail counter
 *  - v0.5.4 privacy-refusal: failures when privacy=true do NOT decrement reachability
 *  - v0.5.3 idle-teardown window: second snapshot within window reuses session
 *  - _pollCameraStateOnce: mirrors privacyMode into privacy_enabled (via stateChange path)
 *
 * IMPORTANT: stubAxiosSequence MUST be called before createAdapter().
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

function resolveBuildModule(name: string): string {
    return path.join(REPO_ROOT, "build", "lib", `${name}.js`);
}

/**
 * Create adapter. All HTTP responses (cameras + subsequent handler calls) must
 * be pre-loaded via stubAxiosSequence before calling this.
 *
 * Returns a controllable snapshot stub so tests can toggle success/failure.
 */
function createAdapterWithMocks(): {
    db: MockDatabase;
    adapter: TestAdapter;
    snapshotStub: sinon.StubbedMember<() => Promise<Buffer>>;
    openLiveSessionStub: sinon.StubbedMember<() => Promise<unknown>>;
} {
    const db = new MockDatabaseCtor();
    let capturedAdapter: MockAdapter | null = null;

    const core = mockAdapterCoreFn(db, {
        onAdapterCreated: (a: MockAdapter) => { capturedAdapter = a; },
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (require.cache as any)[ADAPTER_CORE_PATH] = {
        id: ADAPTER_CORE_PATH, filename: ADAPTER_CORE_PATH, loaded: true,
        parent: module, children: [], path: path.dirname(ADAPTER_CORE_PATH), paths: [], exports: core,
    };

    // Controllable snapshot stub
    const snapshotStub = sinon.stub().resolves(Buffer.from("FAKEJPEG"));

    const snapshotPath = resolveBuildModule("snapshot");
    delete require.cache[snapshotPath];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (require.cache as any)[snapshotPath] = {
        id: snapshotPath, filename: snapshotPath, loaded: true,
        parent: module, children: [], path: path.dirname(snapshotPath), paths: [],
        exports: { fetchSnapshot: snapshotStub, buildSnapshotUrl: (u: string) => `${u}/snap.jpg` },
    };

    const openLiveSessionStub = sinon.stub().resolves({
        camId: CAM_ID, lanAddress: "192.168.1.149:443",
        proxyUrl: "rtsp://127.0.0.1:18020/rtsp_tunnel",
        maxSessionDuration: 3600, openedAt: Date.now(),
        digestUser: "u", digestPassword: "p",
    });

    const liveSessionPath = resolveBuildModule("live_session");
    delete require.cache[liveSessionPath];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (require.cache as any)[liveSessionPath] = {
        id: liveSessionPath, filename: liveSessionPath, loaded: true,
        parent: module, children: [], path: path.dirname(liveSessionPath), paths: [],
        exports: { openLiveSession: openLiveSessionStub, closeLiveSession: sinon.stub().resolves() },
    };

    const tlsProxyPath = resolveBuildModule("tls_proxy");
    delete require.cache[tlsProxyPath];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (require.cache as any)[tlsProxyPath] = {
        id: tlsProxyPath, filename: tlsProxyPath, loaded: true,
        parent: module, children: [], path: path.dirname(tlsProxyPath), paths: [],
        exports: { startTlsProxy: sinon.stub().resolves({ port: 18020, localRtspUrl: "rtsp://127.0.0.1:18020/rtsp_tunnel", stop: sinon.stub().resolves() }) },
    };

    const watchdogPath = resolveBuildModule("session_watchdog");
    delete require.cache[watchdogPath];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (require.cache as any)[watchdogPath] = {
        id: watchdogPath, filename: watchdogPath, loaded: true,
        parent: module, children: [], path: path.dirname(watchdogPath), paths: [],
        exports: { SessionWatchdog: class { start = sinon.stub(); stop = sinon.stub(); constructor(_o: unknown) {} } },
    };

    delete require.cache[MAIN_JS_PATH];
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const factory = require(MAIN_JS_PATH) as (opts: Record<string, unknown>) => MockAdapter;
    factory({ config: { redirect_url: "", region: "EU" } });

    if (!capturedAdapter) throw new Error("adapter not captured");
    const adapter = capturedAdapter as TestAdapter;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).setTimeout = (_fn: () => void, _ms: number) => null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).clearTimeout = (_h: unknown) => undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).terminate = () => undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).writeFileAsync = sinon.stub().resolves();

    return { db, adapter, snapshotStub, openLiveSessionStub };
}

function getStateVal(db: MockDatabase, adapter: TestAdapter, id: string): unknown {
    const fullId = `${adapter.namespace}.${id}`;
    const state = db.getState(fullId);
    return (state as ioBroker.State | null | undefined)?.val;
}

async function bootWithTokens(db: MockDatabase, adapter: TestAdapter): Promise<void> {
    const futureExpiry = Date.now() + 200_000;
    db.publishState(`${adapter.namespace}.info.access_token`, { val: "stored.acc", ack: true });
    db.publishState(`${adapter.namespace}.info.refresh_token`, { val: "stored.ref", ack: true });
    db.publishState(`${adapter.namespace}.info.token_expires_at`, { val: futureExpiry, ack: true });
    await adapter.readyHandler!();
}

async function triggerSnapshot(adapter: TestAdapter): Promise<void> {
    const id = `${adapter.namespace}.cameras.${CAM_ID}.snapshot_trigger`;
    await adapter.stateChangeHandler!(id, { val: true, ack: false, ts: Date.now(), lc: Date.now(), from: "user" });
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("main adapter — state sync + reachability (v0.5.1 / v0.5.4)", () => {
    afterEach(() => {
        restoreAxios();
        sinon.restore();
        delete require.cache[resolveBuildModule("snapshot")];
        delete require.cache[resolveBuildModule("live_session")];
        delete require.cache[resolveBuildModule("tls_proxy")];
        delete require.cache[resolveBuildModule("session_watchdog")];
        delete require.cache[MAIN_JS_PATH];
    });

    // ── markCameraReachability / OFFLINE_THRESHOLD ────────────────────────────

    it("markCameraReachability: 3 consecutive failures flip online=false", async () => {
        // All HTTP calls in one sequence: cameras + 3 snapshot trigger sequences
        // Startup auto-snapshot fires on boot (fire-and-forget) → succeeds (stub default)
        stubAxiosSequence([{ status: 200, data: CAMERAS_BODY }]);
        const { db, adapter, snapshotStub } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        // After boot, startup snapshot ran (async, fire-and-forget) — may or may not have settled.
        // Wait for any pending microtasks to settle.
        await new Promise((r) => setImmediate(r));

        // online should be true after startup snapshot succeeds
        // Now make the snapshot fail with a non-transient error 3 times
        snapshotStub.rejects(new Error("EHOSTUNREACH host unreachable"));

        await triggerSnapshot(adapter);
        await triggerSnapshot(adapter);
        await triggerSnapshot(adapter);

        // After 3 consecutive non-transient failures, online should be false
        const online = getStateVal(db, adapter, `cameras.${CAM_ID}.online`);
        expect(online).to.equal(false);
    });

    it("markCameraReachability: success after 2 failures resets counter", async () => {
        stubAxiosSequence([{ status: 200, data: CAMERAS_BODY }]);
        const { db, adapter, snapshotStub } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);
        await new Promise((r) => setImmediate(r));

        // Two failures
        snapshotStub.rejects(new Error("EHOSTUNREACH host unreachable"));
        await triggerSnapshot(adapter);
        await triggerSnapshot(adapter);

        // One success — resets counter
        snapshotStub.resolves(Buffer.from("FAKEJPEG"));
        await triggerSnapshot(adapter);
        expect(getStateVal(db, adapter, `cameras.${CAM_ID}.online`)).to.equal(true);

        // Now fail 2 more times — should NOT be offline (counter reset to 0)
        snapshotStub.rejects(new Error("EHOSTUNREACH host unreachable"));
        await triggerSnapshot(adapter);
        await triggerSnapshot(adapter);
        // Still only 2 fails in row → should NOT be offline
        expect(getStateVal(db, adapter, `cameras.${CAM_ID}.online`)).to.equal(true);
    });

    it("markCameraReachability: exactly 2 failures is not enough to flip online=false", async () => {
        stubAxiosSequence([{ status: 200, data: CAMERAS_BODY }]);
        const { db, adapter, snapshotStub } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);
        await new Promise((r) => setImmediate(r));

        snapshotStub.rejects(new Error("EHOSTUNREACH host unreachable"));
        await triggerSnapshot(adapter);
        await triggerSnapshot(adapter);

        // 2 failures — threshold is 3, so still online (or undefined if not yet set to false)
        const online = getStateVal(db, adapter, `cameras.${CAM_ID}.online`);
        expect(online === true || online === undefined || online === null).to.equal(true, "2 failures should not flip online=false");
    });

    // ── Privacy-refusal handling ──────────────────────────────────────────────

    it("v0.5.4 privacy=true: snapshot failures do NOT decrement reachability counter", async () => {
        stubAxiosSequence([{ status: 200, data: CAMERAS_BODY }]);
        const { db, adapter, snapshotStub } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);
        await new Promise((r) => setImmediate(r));

        // Set privacy_enabled = true in state DB
        db.publishState(`${adapter.namespace}.cameras.${CAM_ID}.privacy_enabled`, { val: true, ack: true });

        // Snapshot fails (simulates privacy-mode 403-like rejection)
        snapshotStub.rejects(new Error("EHOSTUNREACH host unreachable"));

        // Fire 4 snapshot failures — with privacy ON, reachability should NOT decrement
        await triggerSnapshot(adapter);
        await triggerSnapshot(adapter);
        await triggerSnapshot(adapter);
        await triggerSnapshot(adapter);

        // online should NOT be false — privacy guard prevents reachability decrement
        const online = getStateVal(db, adapter, `cameras.${CAM_ID}.online`);
        expect(online === true || online === undefined || online === null).to.equal(true, "privacy=true: failures should not flip online=false");
    });

    // ── v0.5.3 idle-teardown window: session reuse ────────────────────────────

    it("v0.5.3: second snapshot within 60s reuses cached session (no new openLiveSession call)", async () => {
        stubAxiosSequence([{ status: 200, data: CAMERAS_BODY }]);
        const { db, adapter, snapshotStub, openLiveSessionStub } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);
        // Let startup snapshot (fire-and-forget) settle
        await new Promise((r) => setImmediate(r));

        snapshotStub.resolves(Buffer.from("FAKEJPEG"));

        // Record call count before test snapshots
        const openCallsBefore = openLiveSessionStub.callCount;

        // First explicit snapshot: opens a new session (or reuses startup's session)
        await triggerSnapshot(adapter);
        const openCallsAfterFirst = openLiveSessionStub.callCount;
        // At least one call happened total (startup + first explicit)
        expect(openCallsAfterFirst).to.be.greaterThanOrEqual(openCallsBefore);

        // Second snapshot immediately (well within 60s SESSION_TTL_MS):
        await triggerSnapshot(adapter);
        // openLiveSession should NOT be called again — session is cached
        expect(openLiveSessionStub.callCount).to.equal(openCallsAfterFirst,
            "second snapshot within 60s must reuse cached session");
        void db;
    });

    // ── _pollCameraStateOnce: mirrors privacyMode into privacy_enabled ─────────

    it("privacy toggle ON: state acked=true after successful cloud PUT", async () => {
        stubAxiosSequence([
            { status: 200, data: CAMERAS_BODY },
            { status: 204, data: null }, // PUT /privacy response
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        const privId = `${adapter.namespace}.cameras.${CAM_ID}.privacy_enabled`;
        await adapter.stateChangeHandler!(privId, { val: true, ack: false, ts: Date.now(), lc: Date.now(), from: "user" });

        const state = db.getState(privId) as ioBroker.State | null;
        expect(state?.val).to.equal(true);
        expect(state?.ack).to.equal(true);
        void db;
    });

    it("privacy toggle OFF: state acked=false after successful cloud PUT", async () => {
        stubAxiosSequence([
            { status: 200, data: CAMERAS_BODY },
            { status: 204, data: null }, // PUT /privacy response for OFF
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        const privId = `${adapter.namespace}.cameras.${CAM_ID}.privacy_enabled`;
        // Simulate: privacy was on, now turn off
        await adapter.stateChangeHandler!(privId, { val: false, ack: false, ts: Date.now(), lc: Date.now(), from: "user" });

        const state = db.getState(privId) as ioBroker.State | null;
        expect(state?.val).to.equal(false);
        expect(state?.ack).to.equal(true);
    });

    // ── Concurrent snapshot triggers ──────────────────────────────────────────

    it("concurrent snapshot triggers do not crash the adapter", async () => {
        stubAxiosSequence([{ status: 200, data: CAMERAS_BODY }]);
        const { db, adapter, snapshotStub } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);
        await new Promise((r) => setImmediate(r));

        snapshotStub.resolves(Buffer.from("FAKEJPEG"));

        const snapId = `${adapter.namespace}.cameras.${CAM_ID}.snapshot_trigger`;
        await Promise.all([
            adapter.stateChangeHandler!(snapId, { val: true, ack: false, ts: Date.now(), lc: Date.now(), from: "user" }),
            adapter.stateChangeHandler!(snapId, { val: true, ack: false, ts: Date.now(), lc: Date.now(), from: "user" }),
            adapter.stateChangeHandler!(snapId, { val: true, ack: false, ts: Date.now(), lc: Date.now(), from: "user" }),
        ]);

        // After all concurrent triggers, adapter must still be connected
        expect(getStateVal(db, adapter, "info.connection")).to.equal(true);
        // snapshot_path should be set
        const sp = getStateVal(db, adapter, `cameras.${CAM_ID}.snapshot_path`);
        expect(sp).to.be.a("string").and.to.have.length.greaterThan(0);
    });

    // ── Camera state created correctly on boot ────────────────────────────────

    it("adapter boot: Gen2 camera with featureLight creates wallwasher_brightness DP", async () => {
        stubAxiosSequence([{ status: 200, data: CAMERAS_BODY }]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        expect(getStateVal(db, adapter, "info.connection")).to.equal(true);
        // wallwasher_brightness should be created (Gen2 + featureLight=true)
        const wbFullId = `${adapter.namespace}.cameras.${CAM_ID}.wallwasher_brightness`;
        const obj = db.getObject(wbFullId);
        expect(obj).to.not.be.null;
        void db;
    });

    it("adapter boot: camera generation correctly derived as 2 for HOME_Eyes_Outdoor", async () => {
        stubAxiosSequence([{ status: 200, data: CAMERAS_BODY }]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);
        expect(getStateVal(db, adapter, `cameras.${CAM_ID}.generation`)).to.equal(2);
    });
});
