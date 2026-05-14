/**
 * Tests for src/lib/alarm_light.ts — Gen2 siren + RGB lighting helpers.
 *
 * Locks in:
 *   - setPanicAlarm sends PUT /v11/video_inputs/{id}/panic_alarm with the
 *     correct {"status": "ON"|"OFF"} body and treats 200/201/204 as success
 *   - fetchLightingState returns a normalised LightingState on 200,
 *     null on any non-200
 *   - putLightingState round-trips the body and returns the camera's reply
 *   - normaliseLightingState fills missing/malformed groups with safe
 *     defaults (the camera's response shape has shifted between firmwares)
 *   - buildWallwasherUpdate touches top+bottom LED groups only, never the
 *     front spotlight, and flips color↔whiteBalance correctly
 */

import { expect } from "chai";
import axios, { type AxiosAdapter, type AxiosResponse, type InternalAxiosRequestConfig } from "axios";

import {
    setPanicAlarm,
    fetchLightingState,
    putLightingState,
    buildWallwasherUpdate,
    normaliseLightingState,
    DEFAULT_LIGHTING_STATE,
    type LightingState,
} from "../../src/lib/alarm_light";
import { stubAxiosSequence, restoreAxios } from "./helpers/axios-mock";

const CAM_ID = "EF791764-A48D-4F00-9B32-EF04BEB0DDA0";
const TOKEN = "test-token";

/**
 * Local capture-and-respond stub — like `stubAxiosSequence` but exposes
 * the captured request config so tests can assert on body / URL / method.
 * The shared helper doesn't return the call log; we need it here to verify
 * panic_alarm sends `"ON"`/`"OFF"` correctly.
 */
interface CapturedCall {
    url: string;
    method: string;
    body: unknown;
}
let _savedAdapter: AxiosAdapter | string | readonly (string | AxiosAdapter)[] | undefined;
function stubCapture(responses: Array<Partial<AxiosResponse>>): CapturedCall[] {
    _savedAdapter = axios.defaults.adapter;
    const calls: CapturedCall[] = [];
    let idx = 0;
    axios.defaults.adapter = (config: InternalAxiosRequestConfig): Promise<AxiosResponse> => {
        const body = typeof config.data === "string" ? JSON.parse(config.data) : config.data;
        calls.push({ url: config.url ?? "", method: config.method ?? "", body });
        const r = responses[idx++];
        if (!r) {
            return Promise.reject(new Error(`stubCapture: no response for call #${idx}`));
        }
        return Promise.resolve({
            status: 200,
            statusText: "OK",
            headers: {},
            data: null,
            config,
            request: {},
            ...r,
        } as AxiosResponse);
    };
    return calls;
}
function restoreCapture(): void {
    if (_savedAdapter !== undefined) {
        axios.defaults.adapter = _savedAdapter as AxiosAdapter;
        _savedAdapter = undefined;
    }
}

describe("setPanicAlarm()", () => {
    afterEach(() => restoreCapture());

    it("ON → PUT body {status: 'ON'} and resolves true", async () => {
        const calls = stubCapture([{ status: 204, data: undefined }]);
        const ok = await setPanicAlarm(axios.create(), TOKEN, CAM_ID, true);
        expect(ok).to.equal(true);
        expect(calls[0].body).to.deep.equal({ status: "ON" });
        expect(calls[0].url).to.include(`/v11/video_inputs/${CAM_ID}/panic_alarm`);
        expect(calls[0].method.toUpperCase()).to.equal("PUT");
    });

    it("OFF → PUT body {status: 'OFF'}", async () => {
        const calls = stubCapture([{ status: 204, data: undefined }]);
        await setPanicAlarm(axios.create(), TOKEN, CAM_ID, false);
        expect(calls[0].body).to.deep.equal({ status: "OFF" });
    });

    it("HTTP 401 → resolves false (caller refreshes token)", async () => {
        stubCapture([{ status: 401, data: { error: "expired" } }]);
        const ok = await setPanicAlarm(axios.create(), TOKEN, CAM_ID, true);
        expect(ok).to.equal(false);
    });
});

describe("fetchLightingState() + normaliseLightingState()", () => {
    afterEach(() => restoreAxios());

    it("happy path: full response parsed", async () => {
        const raw = {
            frontLightSettings: { brightness: 50, color: null, whiteBalance: 0.0 },
            topLedLightSettings: { brightness: 80, color: "#FF0000", whiteBalance: null },
            bottomLedLightSettings: { brightness: 80, color: "#FF0000", whiteBalance: null },
        };
        stubAxiosSequence([{ status: 200, data: raw }]);
        const ls = await fetchLightingState(axios.create(), TOKEN, CAM_ID);
        expect(ls).to.not.be.null;
        expect(ls!.topLedLightSettings.color).to.equal("#FF0000");
        expect(ls!.frontLightSettings.brightness).to.equal(50);
    });

    it("missing groups → defaults (0 / null / -1.0)", () => {
        const ls = normaliseLightingState({});
        expect(ls.frontLightSettings.brightness).to.equal(0);
        expect(ls.topLedLightSettings.color).to.be.null;
        expect(ls.bottomLedLightSettings.whiteBalance).to.equal(-1.0);
    });

    it("brightness clamps to 0..100", () => {
        const ls = normaliseLightingState({
            topLedLightSettings: { brightness: 200, color: null, whiteBalance: 0 },
            bottomLedLightSettings: { brightness: -5, color: null, whiteBalance: 0 },
            frontLightSettings: { brightness: 50, color: null, whiteBalance: 0 },
        });
        expect(ls.topLedLightSettings.brightness).to.equal(100);
        expect(ls.bottomLedLightSettings.brightness).to.equal(0);
    });

    it("invalid hex colour rejected (defensive)", () => {
        const ls = normaliseLightingState({
            topLedLightSettings: { brightness: 50, color: "not-a-color", whiteBalance: null },
        });
        expect(ls.topLedLightSettings.color).to.be.null;
    });

    it("hex is normalised to upper-case with # prefix", () => {
        const ls = normaliseLightingState({
            topLedLightSettings: { brightness: 50, color: "ff00aa", whiteBalance: null },
        });
        expect(ls.topLedLightSettings.color).to.equal("#FF00AA");
    });

    it("HTTP 404 → null (caller falls back to default)", async () => {
        stubAxiosSequence([{ status: 404, data: undefined }]);
        const ls = await fetchLightingState(axios.create(), TOKEN, CAM_ID);
        expect(ls).to.be.null;
    });
});

describe("putLightingState()", () => {
    afterEach(() => restoreCapture());

    it("sends full body and returns normalised response", async () => {
        const reply = {
            frontLightSettings: { brightness: 0, color: null, whiteBalance: -1.0 },
            topLedLightSettings: { brightness: 100, color: "#00FF00", whiteBalance: null },
            bottomLedLightSettings: { brightness: 100, color: "#00FF00", whiteBalance: null },
        };
        const calls = stubCapture([{ status: 200, data: reply }]);
        const sent = buildWallwasherUpdate(DEFAULT_LIGHTING_STATE, 100, "#00FF00");
        const ls = await putLightingState(axios.create(), TOKEN, CAM_ID, sent);
        expect(ls).to.not.be.null;
        expect(ls!.topLedLightSettings.color).to.equal("#00FF00");
        // Body must include all three groups (API requirement)
        expect(calls[0].body).to.have.keys(
            "frontLightSettings",
            "topLedLightSettings",
            "bottomLedLightSettings",
        );
    });

    it("204 without body → returns the state we sent (best available view)", async () => {
        stubAxiosSequence([{ status: 204, data: undefined }]);
        const sent = buildWallwasherUpdate(DEFAULT_LIGHTING_STATE, 50, "#112233");
        const ls = await putLightingState(axios.create(), TOKEN, CAM_ID, sent);
        expect(ls).to.deep.equal(sent);
    });

    it("HTTP 500 → null", async () => {
        stubAxiosSequence([{ status: 500, data: { error: "boom" } }]);
        const ls = await putLightingState(
            axios.create(),
            TOKEN,
            CAM_ID,
            DEFAULT_LIGHTING_STATE,
        );
        expect(ls).to.be.null;
    });
});

describe("buildWallwasherUpdate()", () => {
    const base: LightingState = {
        frontLightSettings: { brightness: 70, color: null, whiteBalance: -0.5 },
        topLedLightSettings: { brightness: 30, color: null, whiteBalance: 0.0 },
        bottomLedLightSettings: { brightness: 30, color: null, whiteBalance: 0.0 },
    };

    it("setting colour switches both LED groups to RGB mode", () => {
        const next = buildWallwasherUpdate(base, undefined, "#FF8800");
        expect(next.topLedLightSettings.color).to.equal("#FF8800");
        expect(next.bottomLedLightSettings.color).to.equal("#FF8800");
        // whiteBalance must be null in RGB mode
        expect(next.topLedLightSettings.whiteBalance).to.be.null;
        expect(next.bottomLedLightSettings.whiteBalance).to.be.null;
    });

    it("setting colour=null returns LEDs to white-balance mode", () => {
        const rgb = buildWallwasherUpdate(base, undefined, "#FF0000");
        const back = buildWallwasherUpdate(rgb, undefined, null);
        expect(back.topLedLightSettings.color).to.be.null;
        expect(back.topLedLightSettings.whiteBalance).to.equal(-1.0);
    });

    it("front spotlight stays untouched on wallwasher writes", () => {
        const next = buildWallwasherUpdate(base, 100, "#00FF00");
        expect(next.frontLightSettings).to.deep.equal(base.frontLightSettings);
    });

    it("brightness clamps to 0..100", () => {
        const next = buildWallwasherUpdate(base, 250, undefined);
        expect(next.topLedLightSettings.brightness).to.equal(100);
        const lo = buildWallwasherUpdate(base, -5, undefined);
        expect(lo.bottomLedLightSettings.brightness).to.equal(0);
    });

    it("undefined delta keeps current values", () => {
        const next = buildWallwasherUpdate(base, undefined, undefined);
        expect(next).to.deep.equal(base);
    });
});
