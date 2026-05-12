/**
 * Unit tests for src/lib/cameras.ts
 *
 * Covers:
 *   - fetchCameras()      — happy path, auth error, server error, network error,
 *                           malformed response, auth header format
 *   - detectGeneration()  — Gen1 and Gen2 hardware version strings
 *
 * Framework: Mocha + Chai
 * Mocking:   test/unit/helpers/axios-mock.ts (stubAxiosSequence / stubAxiosError / restoreAxios)
 *
 * Endpoint under test: GET https://residential.cbs.boschsecurity.com/v11/video_inputs
 * Reference: Python bosch_camera.py discover_cameras() + HA __init__.py cam_list parse
 */

import { expect } from "chai";
import axios from "axios";

import {
    fetchCameras,
    detectGeneration,
    UnauthorizedError,
    CamerasApiError,
    type BoschCamera,
} from "../../src/lib/cameras";

import {
    stubAxiosSequence,
    stubAxiosError,
    restoreAxios,
} from "./helpers/axios-mock";

// ── Test fixtures ─────────────────────────────────────────────────────────────

/** Minimal valid raw camera object returned by GET /v11/video_inputs */
const RAW_CAM_OUTDOOR: Record<string, unknown> = {
    id:              "EF791764-A48D-4F00-9B32-EF04BEB0DDA0",
    title:           "Terrasse",
    hardwareVersion: "HOME_Eyes_Outdoor",
    firmwareVersion: "9.40.25",
};

const RAW_CAM_INDOOR: Record<string, unknown> = {
    id:              "20E053B5-0000-0000-0000-000000000001",
    title:           "Innenbereich",
    hardwareVersion: "HOME_Eyes_Indoor",
    firmwareVersion: "9.40.25",
};

const RAW_CAM_360: Record<string, unknown> = {
    id:              "09ECD6E9-0000-0000-0000-000000000002",
    title:           "Kamera",
    hardwareVersion: "CAMERA_360",
    firmwareVersion: "7.91.56",
};

const BEARER_TOKEN = "test-access-token-abc123";

// ── detectGeneration() ────────────────────────────────────────────────────────

describe("detectGeneration()", () => {
    it("HOME_Eyes_Outdoor → 2", () => {
        expect(detectGeneration("HOME_Eyes_Outdoor")).to.equal(2);
    });

    it("HOME_Eyes_Indoor → 2", () => {
        expect(detectGeneration("HOME_Eyes_Indoor")).to.equal(2);
    });

    it("CAMERA_OUTDOOR_GEN2 → 2", () => {
        expect(detectGeneration("CAMERA_OUTDOOR_GEN2")).to.equal(2);
    });

    it("CAMERA_INDOOR_GEN2 → 2", () => {
        expect(detectGeneration("CAMERA_INDOOR_GEN2")).to.equal(2);
    });

    it("CAMERA_360 → 1", () => {
        expect(detectGeneration("CAMERA_360")).to.equal(1);
    });

    it("INDOOR → 1", () => {
        expect(detectGeneration("INDOOR")).to.equal(1);
    });

    it("OUTDOOR → 1", () => {
        expect(detectGeneration("OUTDOOR")).to.equal(1);
    });

    it("CAMERA_EYES → 1", () => {
        expect(detectGeneration("CAMERA_EYES")).to.equal(1);
    });

    it("unknown string → 1 (safe default)", () => {
        expect(detectGeneration("UNKNOWN_MODEL_XYZ")).to.equal(1);
    });

    it("empty string → 1 (safe default)", () => {
        expect(detectGeneration("")).to.equal(1);
    });
});

// ── fetchCameras() — happy paths ──────────────────────────────────────────────

describe("fetchCameras() happy path", () => {
    afterEach(() => {
        restoreAxios();
    });

    it("happy path: 2 cameras → returns 2 BoschCamera objects with correct fields", async () => {
        stubAxiosSequence([{
            status: 200,
            data: [RAW_CAM_OUTDOOR, RAW_CAM_INDOOR],
        }]);
        const result = await fetchCameras(axios.create(), BEARER_TOKEN);
        expect(result).to.have.lengthOf(2);

        const outdoor = result.find((c: BoschCamera) => c.id === RAW_CAM_OUTDOOR.id);
        expect(outdoor).to.exist;
        expect(outdoor!.name).to.equal("Terrasse");
        expect(outdoor!.hardwareVersion).to.equal("HOME_Eyes_Outdoor");
        expect(outdoor!.firmwareVersion).to.equal("9.40.25");
        expect(outdoor!.generation).to.equal(2);
        expect(outdoor!.online).to.equal(false);

        const indoor = result.find((c: BoschCamera) => c.id === RAW_CAM_INDOOR.id);
        expect(indoor).to.exist;
        expect(indoor!.name).to.equal("Innenbereich");
        expect(indoor!.generation).to.equal(2);
    });

    it("happy path: 0 cameras → returns empty array", async () => {
        stubAxiosSequence([{ status: 200, data: [] }]);
        const result = await fetchCameras(axios.create(), BEARER_TOKEN);
        expect(result).to.be.an("array").that.is.empty;
    });

    it("happy path: mixed Gen1 + Gen2 cameras mapped correctly", async () => {
        stubAxiosSequence([{
            status: 200,
            data: [RAW_CAM_OUTDOOR, RAW_CAM_360],
        }]);
        const result = await fetchCameras(axios.create(), BEARER_TOKEN);
        expect(result).to.have.lengthOf(2);

        const gen2 = result.find((c: BoschCamera) => c.id === RAW_CAM_OUTDOOR.id);
        const gen1 = result.find((c: BoschCamera) => c.id === RAW_CAM_360.id);
        expect(gen2!.generation).to.equal(2);
        expect(gen1!.generation).to.equal(1);
        expect(gen1!.name).to.equal("Kamera");
        expect(gen1!.firmwareVersion).to.equal("7.91.56");
    });

    it("online defaults to false (list endpoint has no connection state)", async () => {
        stubAxiosSequence([{ status: 200, data: [RAW_CAM_OUTDOOR] }]);
        const result = await fetchCameras(axios.create(), BEARER_TOKEN);
        expect(result[0].online).to.equal(false);
    });
});

// ── fetchCameras() — error classification ─────────────────────────────────────

describe("fetchCameras() error classification", () => {
    afterEach(() => {
        restoreAxios();
    });

    it("HTTP 401 → throws UnauthorizedError (caller must refresh token)", async () => {
        stubAxiosError(401, { error: "Unauthorized" });
        try {
            await fetchCameras(axios.create(), "expired-token");
            expect.fail("should have thrown");
        } catch (err: unknown) {
            expect(err).to.be.instanceOf(UnauthorizedError);
            expect((err as UnauthorizedError).name).to.equal("UnauthorizedError");
        }
    });

    it("HTTP 500 → throws CamerasApiError (do not invalidate token)", async () => {
        stubAxiosError(500, "Internal Server Error");
        try {
            await fetchCameras(axios.create(), BEARER_TOKEN);
            expect.fail("should have thrown");
        } catch (err: unknown) {
            expect(err).to.be.instanceOf(CamerasApiError);
            expect((err as CamerasApiError).name).to.equal("CamerasApiError");
        }
    });

    it("HTTP 503 → throws CamerasApiError", async () => {
        stubAxiosError(503, "Service Unavailable");
        try {
            await fetchCameras(axios.create(), BEARER_TOKEN);
            expect.fail("should have thrown");
        } catch (err: unknown) {
            expect(err).to.be.instanceOf(CamerasApiError);
        }
    });

    it("network error (no response) → throws CamerasApiError", async () => {
        const savedAdapter = axios.defaults.adapter;
        axios.defaults.adapter = (): Promise<never> => {
            const err = Object.assign(new Error("ECONNREFUSED"), {
                isAxiosError: true,
                // no .response — pure network failure
            });
            return Promise.reject(err);
        };
        try {
            await fetchCameras(axios.create(), BEARER_TOKEN);
            expect.fail("should have thrown");
        } catch (err: unknown) {
            expect(err).to.be.instanceOf(CamerasApiError);
        } finally {
            axios.defaults.adapter = savedAdapter as typeof axios.defaults.adapter;
        }
    });

    it("HTTP 401 does NOT throw CamerasApiError (distinct error types)", async () => {
        stubAxiosError(401, {});
        try {
            await fetchCameras(axios.create(), BEARER_TOKEN);
            expect.fail("should have thrown");
        } catch (err: unknown) {
            expect(err).to.not.be.instanceOf(CamerasApiError);
            expect(err).to.be.instanceOf(UnauthorizedError);
        }
    });
});

// ── fetchCameras() — malformed / edge-case responses ─────────────────────────

describe("fetchCameras() malformed/edge-case responses", () => {
    afterEach(() => {
        restoreAxios();
    });

    it("camera with missing id is silently skipped", async () => {
        stubAxiosSequence([{
            status: 200,
            data: [
                { title: "No ID cam", hardwareVersion: "CAMERA_360", firmwareVersion: "7.91.56" },
                RAW_CAM_OUTDOOR,
            ],
        }]);
        const result = await fetchCameras(axios.create(), BEARER_TOKEN);
        // Only the valid cam (with id) should be returned
        expect(result).to.have.lengthOf(1);
        expect(result[0].id).to.equal(RAW_CAM_OUTDOOR.id);
    });

    it("camera with empty string id is silently skipped", async () => {
        stubAxiosSequence([{
            status: 200,
            data: [
                { id: "", title: "Empty ID", hardwareVersion: "CAMERA_360", firmwareVersion: "7.91.56" },
                RAW_CAM_360,
            ],
        }]);
        const result = await fetchCameras(axios.create(), BEARER_TOKEN);
        expect(result).to.have.lengthOf(1);
        expect(result[0].id).to.equal(RAW_CAM_360.id);
    });

    it("missing title falls back to id", async () => {
        stubAxiosSequence([{
            status: 200,
            data: [{ id: "SOME-UUID-001", hardwareVersion: "CAMERA_360", firmwareVersion: "7.91.56" }],
        }]);
        const result = await fetchCameras(axios.create(), BEARER_TOKEN);
        expect(result[0].name).to.equal("SOME-UUID-001");
    });

    it("missing hardwareVersion uses empty string (maps to Gen1)", async () => {
        stubAxiosSequence([{
            status: 200,
            data: [{ id: "SOME-UUID-002", title: "Mystery Cam" }],
        }]);
        const result = await fetchCameras(axios.create(), BEARER_TOKEN);
        expect(result[0].hardwareVersion).to.equal("");
        expect(result[0].generation).to.equal(1);
    });

    it("non-array response body → returns empty array (no throw)", async () => {
        stubAxiosSequence([{ status: 200, data: { unexpected: "object" } }]);
        const result = await fetchCameras(axios.create(), BEARER_TOKEN);
        expect(result).to.be.an("array").that.is.empty;
    });

    it("null response body → returns empty array (no throw)", async () => {
        stubAxiosSequence([{ status: 200, data: null }]);
        const result = await fetchCameras(axios.create(), BEARER_TOKEN);
        expect(result).to.be.an("array").that.is.empty;
    });
});

// ── fetchCameras() — auth header verification ─────────────────────────────────

describe("fetchCameras() auth header", () => {
    it("sends exact Authorization: Bearer <token> header", async () => {
        let capturedHeaders: Record<string, string> | undefined;
        const savedAdapter = axios.defaults.adapter;
        axios.defaults.adapter = (config): Promise<unknown> => {
            capturedHeaders = config.headers as Record<string, string>;
            return Promise.resolve({
                status: 200,
                statusText: "OK",
                headers: {},
                data: [],
                config,
                request: {},
            });
        };
        try {
            await fetchCameras(axios.create(), BEARER_TOKEN);
            expect(capturedHeaders).to.exist;
            expect(capturedHeaders!["Authorization"]).to.equal(`Bearer ${BEARER_TOKEN}`);
        } finally {
            axios.defaults.adapter = savedAdapter as typeof axios.defaults.adapter;
        }
    });

    it("sends Accept: application/json header", async () => {
        let capturedHeaders: Record<string, string> | undefined;
        const savedAdapter = axios.defaults.adapter;
        axios.defaults.adapter = (config): Promise<unknown> => {
            capturedHeaders = config.headers as Record<string, string>;
            return Promise.resolve({
                status: 200,
                statusText: "OK",
                headers: {},
                data: [],
                config,
                request: {},
            });
        };
        try {
            await fetchCameras(axios.create(), BEARER_TOKEN);
            expect(capturedHeaders!["Accept"]).to.equal("application/json");
        } finally {
            axios.defaults.adapter = savedAdapter as typeof axios.defaults.adapter;
        }
    });
});
