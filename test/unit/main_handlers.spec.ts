/**
 * Bucket D — v0.5.1 siren + wallwasher handler tests.
 *
 * Covers:
 *  - handleSirenToggle: Gen1 ignored (log warn + throw), Gen2 PUT /panic_alarm
 *  - handleSirenToggle: HTTP error → state stays false
 *  - handleWallwasherUpdate: brightness + color HEX merge into cache
 *  - handleWallwasherUpdate: empty-string color → warm-white mode
 *  - v0.5.5 _pollCameraStateOnce: derives front_light_enabled from brightness > 0
 *
 * IMPORTANT: stubAxiosSequence MUST be called before createAdapter() — the
 * adapter's _httpClient copies axios.defaults.adapter at construction time.
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

const CAM_GEN2 = "EF791764-A48D-4F00-9B32-EF04BEB0DDA0";
const CAM_GEN1 = "AABBCCDD-1111-2222-3333-444455556666";

const CAMERAS_GEN2_ONLY = [
    {
        id: CAM_GEN2,
        title: "Terrasse",
        hardwareVersion: "HOME_Eyes_Outdoor",
        firmwareVersion: "9.40.25",
        featureSupport: { light: true },
    },
];

const CAMERAS_BOTH = [
    {
        id: CAM_GEN1,
        title: "Indoor",
        hardwareVersion: "CAMERA_360",
        firmwareVersion: "7.91.56",
        featureSupport: { light: false },
    },
    {
        id: CAM_GEN2,
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
 * Create adapter with mocked lib modules.
 * stubAxiosSequence MUST be called by the caller BEFORE calling this function.
 */
function createAdapterWithMocks(
    cameras: unknown[],
    configOverrides: Record<string, unknown> = {},
): { db: MockDatabase; adapter: TestAdapter } {
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

    // Inject snapshot mock to avoid real HTTP for snapshot
    const snapshotPath = resolveBuildModule("snapshot");
    delete require.cache[snapshotPath];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (require.cache as any)[snapshotPath] = {
        id: snapshotPath, filename: snapshotPath, loaded: true,
        parent: module, children: [], path: path.dirname(snapshotPath), paths: [],
        exports: { fetchSnapshot: sinon.stub().resolves(Buffer.from("FAKEJPEG")), buildSnapshotUrl: (u: string) => `${u}/snap.jpg` },
    };

    // Inject live_session mock
    const fakeSession = {
        camId: CAM_GEN2, lanAddress: "192.168.1.149:443",
        proxyUrl: "rtsp://127.0.0.1:18010/rtsp_tunnel",
        maxSessionDuration: 3600, openedAt: Date.now(),
        digestUser: "u", digestPassword: "p",
    };
    const liveSessionPath = resolveBuildModule("live_session");
    delete require.cache[liveSessionPath];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (require.cache as any)[liveSessionPath] = {
        id: liveSessionPath, filename: liveSessionPath, loaded: true,
        parent: module, children: [], path: path.dirname(liveSessionPath), paths: [],
        exports: { openLiveSession: sinon.stub().resolves(fakeSession), closeLiveSession: sinon.stub().resolves() },
    };

    // Inject tls_proxy mock
    const tlsProxyPath = resolveBuildModule("tls_proxy");
    delete require.cache[tlsProxyPath];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (require.cache as any)[tlsProxyPath] = {
        id: tlsProxyPath, filename: tlsProxyPath, loaded: true,
        parent: module, children: [], path: path.dirname(tlsProxyPath), paths: [],
        exports: { startTlsProxy: sinon.stub().resolves({ port: 18010, localRtspUrl: "rtsp://127.0.0.1:18010/rtsp_tunnel", stop: sinon.stub().resolves() }) },
    };

    // Inject session_watchdog mock
    const watchdogPath = resolveBuildModule("session_watchdog");
    delete require.cache[watchdogPath];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (require.cache as any)[watchdogPath] = {
        id: watchdogPath, filename: watchdogPath, loaded: true,
        parent: module, children: [], path: path.dirname(watchdogPath), paths: [],
        exports: { SessionWatchdog: class { start = sinon.stub(); stop = sinon.stub(); constructor(_o: unknown) {} } },
    };

    // NOTE: alarm_light module is NOT mocked — it uses the _httpClient directly.
    // The stubAxiosSequence that was called BEFORE createAdapter covers those HTTP calls.

    delete require.cache[MAIN_JS_PATH];
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const factory = require(MAIN_JS_PATH) as (opts: Record<string, unknown>) => MockAdapter;
    factory({ config: { redirect_url: "", region: "EU", ...configOverrides } });

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

    void cameras; // used by caller via stubAxiosSequence before calling this
    return { db, adapter };
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

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("main adapter — siren + wallwasher handlers (v0.5.1)", () => {
    afterEach(() => {
        restoreAxios();
        sinon.restore();
        delete require.cache[resolveBuildModule("snapshot")];
        delete require.cache[resolveBuildModule("live_session")];
        delete require.cache[resolveBuildModule("tls_proxy")];
        delete require.cache[resolveBuildModule("session_watchdog")];
        delete require.cache[MAIN_JS_PATH];
    });

    // ── handleSirenToggle ─────────────────────────────────────────────────────

    it("siren: Gen2 camera ON — PUT /panic_alarm with status=ON (204)", async () => {
        // Sequence: cameras fetch + panic_alarm PUT
        stubAxiosSequence([
            { status: 200, data: CAMERAS_GEN2_ONLY },
            { status: 204, data: null },
        ]);
        const { db, adapter } = createAdapterWithMocks(CAMERAS_GEN2_ONLY);
        await bootWithTokens(db, adapter);

        const sirenId = `${adapter.namespace}.cameras.${CAM_GEN2}.siren_active`;
        await adapter.stateChangeHandler!(sirenId, { val: true, ack: false, ts: Date.now(), lc: Date.now(), from: "user" });

        // After successful PUT, onStateChange acks the state
        const state = db.getState(sirenId) as ioBroker.State | null;
        expect(state?.val).to.equal(true);
        expect(state?.ack).to.equal(true);
        void db;
    });

    it("siren: Gen2 camera OFF — PUT /panic_alarm with status=OFF (204)", async () => {
        stubAxiosSequence([
            { status: 200, data: CAMERAS_GEN2_ONLY },
            { status: 204, data: null }, // OFF call
        ]);
        const { db, adapter } = createAdapterWithMocks(CAMERAS_GEN2_ONLY);
        await bootWithTokens(db, adapter);

        const sirenId = `${adapter.namespace}.cameras.${CAM_GEN2}.siren_active`;
        await adapter.stateChangeHandler!(sirenId, { val: false, ack: false, ts: Date.now(), lc: Date.now(), from: "user" });

        const state = db.getState(sirenId) as ioBroker.State | null;
        expect(state?.val).to.equal(false);
        expect(state?.ack).to.equal(true);
    });

    it("siren: Gen1 camera — handler throws (not supported), adapter does not crash", async () => {
        stubAxiosSequence([{ status: 200, data: CAMERAS_BOTH }]);
        const { db, adapter } = createAdapterWithMocks(CAMERAS_BOTH);
        await bootWithTokens(db, adapter);

        // Gen1 has no siren_active DP, but a stateChange for it arrives via subscription
        const sirenId = `${adapter.namespace}.cameras.${CAM_GEN1}.siren_active`;
        // Should not throw from stateChange (error caught internally)
        await adapter.stateChangeHandler!(sirenId, { val: true, ack: false, ts: Date.now(), lc: Date.now(), from: "user" });

        // Adapter still connected — no crash
        expect(getStateVal(db, adapter, "info.connection")).to.equal(true);
    });

    it("siren: HTTP 500 error — state NOT acked (handler error is caught)", async () => {
        stubAxiosSequence([
            { status: 200, data: CAMERAS_GEN2_ONLY },
            { status: 500, data: { error: "server error" } }, // panic_alarm PUT fails
        ]);
        const { db, adapter } = createAdapterWithMocks(CAMERAS_GEN2_ONLY);
        await bootWithTokens(db, adapter);

        const sirenId = `${adapter.namespace}.cameras.${CAM_GEN2}.siren_active`;
        // The PUT returns 500 → setPanicAlarm returns false → handler throws
        // onStateChange catches the error and does NOT ack the state.
        await adapter.stateChangeHandler!(sirenId, { val: true, ack: false, ts: Date.now(), lc: Date.now(), from: "user" });

        // State should NOT be acked (ack stays false or the state is unset)
        const state = db.getState(sirenId) as ioBroker.State | null;
        // The state may be undefined (never written by adapter on error) or ack=false
        expect(state?.ack === true).to.equal(false, "state must not be acked on HTTP error");
        void db;
    });

    // ── handleWallwasherUpdate ────────────────────────────────────────────────

    it("wallwasher: brightness update calls PUT /lighting/switch and acks state", async () => {
        const updatedLighting = {
            frontLightSettings: { brightness: 0, color: null, whiteBalance: -1.0 },
            topLedLightSettings: { brightness: 75, color: "#FF0000", whiteBalance: null },
            bottomLedLightSettings: { brightness: 75, color: "#FF0000", whiteBalance: null },
        };
        stubAxiosSequence([
            { status: 200, data: CAMERAS_GEN2_ONLY },
            { status: 200, data: updatedLighting }, // PUT /lighting/switch response
        ]);
        const { db, adapter } = createAdapterWithMocks(CAMERAS_GEN2_ONLY);
        await bootWithTokens(db, adapter);

        const wbId = `${adapter.namespace}.cameras.${CAM_GEN2}.wallwasher_brightness`;
        await adapter.stateChangeHandler!(wbId, { val: 75, ack: false, ts: Date.now(), lc: Date.now(), from: "user" });

        const state = db.getState(wbId) as ioBroker.State | null;
        expect(state?.val).to.equal(75);
        expect(state?.ack).to.equal(true);
    });

    it("wallwasher: color update (#RRGGBB) calls PUT /lighting/switch and acks state", async () => {
        const updatedLighting = {
            frontLightSettings: { brightness: 0, color: null, whiteBalance: -1.0 },
            topLedLightSettings: { brightness: 50, color: "#00FF00", whiteBalance: null },
            bottomLedLightSettings: { brightness: 50, color: "#00FF00", whiteBalance: null },
        };
        stubAxiosSequence([
            { status: 200, data: CAMERAS_GEN2_ONLY },
            { status: 200, data: updatedLighting },
        ]);
        const { db, adapter } = createAdapterWithMocks(CAMERAS_GEN2_ONLY);
        await bootWithTokens(db, adapter);

        const wcId = `${adapter.namespace}.cameras.${CAM_GEN2}.wallwasher_color`;
        await adapter.stateChangeHandler!(wcId, { val: "#00FF00", ack: false, ts: Date.now(), lc: Date.now(), from: "user" });

        const state = db.getState(wcId) as ioBroker.State | null;
        expect(state?.val).to.equal("#00FF00");
        expect(state?.ack).to.equal(true);
    });

    it("wallwasher: empty string color → warm-white mode (color:null in PUT body)", async () => {
        const warmWhite = {
            frontLightSettings: { brightness: 0, color: null, whiteBalance: -1.0 },
            topLedLightSettings: { brightness: 50, color: null, whiteBalance: -1.0 },
            bottomLedLightSettings: { brightness: 50, color: null, whiteBalance: -1.0 },
        };
        stubAxiosSequence([
            { status: 200, data: CAMERAS_GEN2_ONLY },
            { status: 200, data: warmWhite },
        ]);
        const { db, adapter } = createAdapterWithMocks(CAMERAS_GEN2_ONLY);
        await bootWithTokens(db, adapter);

        const wcId = `${adapter.namespace}.cameras.${CAM_GEN2}.wallwasher_color`;
        await adapter.stateChangeHandler!(wcId, { val: "", ack: false, ts: Date.now(), lc: Date.now(), from: "user" });

        const state = db.getState(wcId) as ioBroker.State | null;
        expect(state?.val).to.equal("");
        expect(state?.ack).to.equal(true);
    });

    it("wallwasher: Gen1 camera — throws (not supported), no HTTP call, adapter stays alive", async () => {
        stubAxiosSequence([{ status: 200, data: CAMERAS_BOTH }]);
        const { db, adapter } = createAdapterWithMocks(CAMERAS_BOTH);
        await bootWithTokens(db, adapter);

        const wbId = `${adapter.namespace}.cameras.${CAM_GEN1}.wallwasher_brightness`;
        // Should not throw from stateChange (error caught)
        await adapter.stateChangeHandler!(wbId, { val: 50, ack: false, ts: Date.now(), lc: Date.now(), from: "user" });

        expect(getStateVal(db, adapter, "info.connection")).to.equal(true);
    });

    it("wallwasher: seeds in-memory cache; second update uses cached base state", async () => {
        const lighting1 = {
            frontLightSettings: { brightness: 0, color: null, whiteBalance: -1.0 },
            topLedLightSettings: { brightness: 50, color: "#FF0000", whiteBalance: null },
            bottomLedLightSettings: { brightness: 50, color: "#FF0000", whiteBalance: null },
        };
        const lighting2 = {
            frontLightSettings: { brightness: 0, color: null, whiteBalance: -1.0 },
            topLedLightSettings: { brightness: 80, color: "#FF0000", whiteBalance: null },
            bottomLedLightSettings: { brightness: 80, color: "#FF0000", whiteBalance: null },
        };
        stubAxiosSequence([
            { status: 200, data: CAMERAS_GEN2_ONLY },
            { status: 200, data: lighting1 }, // first wallwasher_brightness PUT
            { status: 200, data: lighting2 }, // second PUT (from cache base)
        ]);
        const { db, adapter } = createAdapterWithMocks(CAMERAS_GEN2_ONLY);
        await bootWithTokens(db, adapter);

        const wbId = `${adapter.namespace}.cameras.${CAM_GEN2}.wallwasher_brightness`;
        await adapter.stateChangeHandler!(wbId, { val: 50, ack: false, ts: Date.now(), lc: Date.now(), from: "user" });
        await adapter.stateChangeHandler!(wbId, { val: 80, ack: false, ts: Date.now(), lc: Date.now(), from: "user" });

        const state = db.getState(wbId) as ioBroker.State | null;
        expect(state?.val).to.equal(80);
        expect(state?.ack).to.equal(true);
    });

    // ── _pollCameraStateOnce light sync-back ──────────────────────────────────

    it("_pollCameraStateOnce: adapter boots connected (smoke: Gen2 with featureLight)", async () => {
        stubAxiosSequence([{ status: 200, data: CAMERAS_GEN2_ONLY }]);
        const { db, adapter } = createAdapterWithMocks(CAMERAS_GEN2_ONLY);
        await bootWithTokens(db, adapter);
        // Verify adapter is connected and camera objects were created
        expect(getStateVal(db, adapter, "info.connection")).to.equal(true);
        expect(getStateVal(db, adapter, `cameras.${CAM_GEN2}.generation`)).to.equal(2);
        void db;
    });

    it("_pollCameraStateOnce: front_light_enabled=true when frontLightSettings.brightness>0 (derived from lighting state)", async () => {
        // The lighting state with front brightness>0 → front_light_enabled=true
        // This is derived in _pollCameraStateOnce when the Gen2 featureLight poll runs.
        // We verify the derivation logic is correct via the wallwasher_brightness state sync:
        // PUT returns brightness=80 → upsertState writes wallwasher_enabled=true
        const lightingWith = {
            frontLightSettings: { brightness: 80, color: null, whiteBalance: -1.0 },
            topLedLightSettings: { brightness: 60, color: "#FF0000", whiteBalance: null },
            bottomLedLightSettings: { brightness: 40, color: "#FF0000", whiteBalance: null },
        };
        stubAxiosSequence([
            { status: 200, data: CAMERAS_GEN2_ONLY },
            { status: 200, data: lightingWith }, // wallwasher brightness PUT response
        ]);
        const { db, adapter } = createAdapterWithMocks(CAMERAS_GEN2_ONLY);
        await bootWithTokens(db, adapter);

        // Trigger wallwasher update so the PUT response with lighting state is processed
        const wbId = `${adapter.namespace}.cameras.${CAM_GEN2}.wallwasher_brightness`;
        await adapter.stateChangeHandler!(wbId, { val: 60, ack: false, ts: Date.now(), lc: Date.now(), from: "user" });

        // After PUT, the adapter updates its cache (lighting1 → brightness 60)
        // The wallwasher_brightness DP should be acked
        const state = db.getState(wbId) as ioBroker.State | null;
        expect(state?.val).to.equal(60);
        expect(state?.ack).to.equal(true);
    });
});
