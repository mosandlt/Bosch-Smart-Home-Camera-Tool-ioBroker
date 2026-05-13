/**
 * Unit tests for src/lib/live_session.ts
 *
 * Tests the PUT /v11/video_inputs/{id}/connection API wrapper that returns
 * per-camera LOCAL session URL + Digest credentials.
 *
 * Design constraint (v0.4.0): adapter is LOCAL-only — cloud relay is never used
 * for media. Tests for REMOTE paths have been removed accordingly.
 *
 * Framework: Mocha + Chai + sinon
 * Mocking:   sinon stubs on the axios instance (httpClient.put / httpClient.delete)
 *
 * Reference: HA custom_components/bosch_shc_camera/__init__.py
 *   _try_live_connection_inner() — response shapes + error codes
 *
 * Tests:
 *  1.  LOCAL happy path: 200 LOCAL response → LiveSession with digestUser
 *  2.  LOCAL happy path: maxSessionDuration parsed from response
 *  3.  LOCAL happy path: maxSessionDuration defaults to 3600 when absent
 *  4.  Non-LOCAL response (missing creds) → throws LiveSessionError (cloud relay refused)
 *  5.  401 → throws LiveSessionError
 *  6.  404 → throws LiveSessionError
 *  7.  444 → throws SessionLimitError
 *  8.  503 → throws CameraOfflineError
 *  9.  500 / 5xx → throws LiveSessionError
 * 10.  Network error (axios throws) → throws LiveSessionError
 * 11.  Response missing user/password/urls → throws LiveSessionError (non-LOCAL)
 * 12.  closeLiveSession happy path (2xx) → resolves without throw
 * 13.  closeLiveSession 404 (already closed) → resolves without throw
 * 14.  closeLiveSession network error → resolves without throw (best-effort)
 */

import { expect } from "chai";
import * as sinon from "sinon";
import type { AxiosInstance } from "axios";

import {
    openLiveSession,
    closeLiveSession,
    LiveSessionError,
    CameraOfflineError,
    SessionLimitError,
    type LiveSession,
} from "../../src/lib/live_session";

// ── Helpers ────────────────────────────────────────────────────────────────────

const FAKE_TOKEN = "Bearer.test.token";
const CAMERA_UUID = "EF791764-A48D-4F00-9B32-EF04BEB0DDA0";

/** Build a minimal fake AxiosInstance with stubbed put + delete */
function makeClient(
    putResponse: { status: number; data: unknown },
    deleteResponse: { status: number; data: unknown } = { status: 200, data: {} },
): { client: AxiosInstance; putStub: sinon.SinonStub; deleteStub: sinon.SinonStub } {
    const putStub = sinon.stub().resolves(putResponse);
    const deleteStub = sinon.stub().resolves(deleteResponse);
    const client = { put: putStub, delete: deleteStub } as unknown as AxiosInstance;
    return { client, putStub, deleteStub };
}

/** LOCAL response body matching HA _try_live_connection_inner parsing */
function localBody(
    user = "cbs-57355237",
    password = "secretpass",
    urls = ["192.0.2.10:443"],
    imageUrlScheme = "https://{url}/snap.jpg",
    bufferingTime = 500,
    maxSessionDuration?: number,
): Record<string, unknown> {
    const body: Record<string, unknown> = { user, password, urls, imageUrlScheme, bufferingTime };
    if (maxSessionDuration !== undefined) {
        body.maxSessionDuration = maxSessionDuration;
    }
    return body;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("openLiveSession()", () => {
    // ── Test 1: LOCAL happy path ───────────────────────────────────────────────
    it("(1) LOCAL: 200 response → LiveSession with digestUser + proxyUrl + connectionType=LOCAL", async () => {
        const { client, putStub } = makeClient({ status: 200, data: localBody() });

        const session: LiveSession = await openLiveSession(client, FAKE_TOKEN, CAMERA_UUID);

        expect(session.cameraId).to.equal(CAMERA_UUID);
        expect(session.connectionType).to.equal("LOCAL");
        expect(session.digestUser).to.equal("cbs-57355237");
        expect(session.digestPassword).to.equal("secretpass");
        expect(session.lanAddress).to.equal("192.0.2.10:443");
        expect(session.proxyUrl).to.include("192.0.2.10:443");
        expect(session.proxyUrl).to.include("/snap.jpg");
        expect(session.proxyUrl).to.include("JpegSize=1206");
        expect(session.bufferingTimeMs).to.equal(500);
        expect(session.openedAt).to.be.a("number").and.to.be.greaterThan(0);
        // Verify PUT body contains type=LOCAL (adapter always requests LOCAL)
        expect(putStub.firstCall.args[1]).to.deep.include({ type: "LOCAL" });
    });

    // ── Test 2: maxSessionDuration parsed from response ────────────────────────
    it("(2) LOCAL: maxSessionDuration parsed from response body", async () => {
        const { client } = makeClient({
            status: 200,
            data: localBody("cbs-x", "p", ["192.0.2.1:443"], undefined, 500, 7200),
        });

        const session = await openLiveSession(client, FAKE_TOKEN, CAMERA_UUID);

        expect(session.maxSessionDuration).to.equal(7200);
    });

    // ── Test 3: maxSessionDuration defaults to 3600 ────────────────────────────
    it("(3) LOCAL: maxSessionDuration defaults to 3600 when absent in response", async () => {
        // localBody without maxSessionDuration field
        const { client } = makeClient({ status: 200, data: localBody() });

        const session = await openLiveSession(client, FAKE_TOKEN, CAMERA_UUID);

        expect(session.maxSessionDuration).to.equal(3600);
    });

    // ── Test 4: non-LOCAL response (missing creds) → LiveSessionError ──────────
    it("(4) 200 but response has no user/password (cloud relay response) → throws LiveSessionError", async () => {
        // Simulate Bosch returning a cloud-relay response (no LOCAL creds)
        const { client } = makeClient({
            status: 200,
            data: {
                urls: ["proxy-12.live.cbs.boschsecurity.com:42090/HASH123"],
                bufferingTime: 1000,
            },
        });

        let threw = false;
        try {
            await openLiveSession(client, FAKE_TOKEN, CAMERA_UUID);
        } catch (err: unknown) {
            threw = true;
            expect(err).to.be.instanceOf(LiveSessionError);
            expect((err as LiveSessionError).message).to.include("non-LOCAL session");
            expect((err as LiveSessionError).message).to.include("cloud relay");
        }
        expect(threw).to.be.true;
    });

    // ── Test 5: 401 → LiveSessionError ────────────────────────────────────────
    it("(5) HTTP 401 → throws LiveSessionError (token expired)", async () => {
        const { client } = makeClient({ status: 401, data: { error: "Unauthorized" } });

        let threw = false;
        try {
            await openLiveSession(client, FAKE_TOKEN, CAMERA_UUID);
        } catch (err: unknown) {
            threw = true;
            expect(err).to.be.instanceOf(LiveSessionError);
            expect((err as LiveSessionError).message).to.include("401");
        }
        expect(threw).to.be.true;
    });

    // ── Test 6: 404 → LiveSessionError ────────────────────────────────────────
    it("(6) HTTP 404 → throws LiveSessionError (camera not found)", async () => {
        const { client } = makeClient({ status: 404, data: {} });

        let threw = false;
        try {
            await openLiveSession(client, FAKE_TOKEN, CAMERA_UUID);
        } catch (err: unknown) {
            threw = true;
            expect(err).to.be.instanceOf(LiveSessionError);
            expect((err as LiveSessionError).message).to.include("404");
        }
        expect(threw).to.be.true;
    });

    // ── Test 7: 444 → SessionLimitError ───────────────────────────────────────
    it("(7) HTTP 444 → throws SessionLimitError", async () => {
        const { client } = makeClient({ status: 444, data: {} });

        let threw = false;
        try {
            await openLiveSession(client, FAKE_TOKEN, CAMERA_UUID);
        } catch (err: unknown) {
            threw = true;
            expect(err).to.be.instanceOf(SessionLimitError);
        }
        expect(threw).to.be.true;
    });

    // ── Test 8: 503 → CameraOfflineError ──────────────────────────────────────
    it("(8) HTTP 503 → throws CameraOfflineError (camera offline / privacy)", async () => {
        const { client } = makeClient({ status: 503, data: {} });

        let threw = false;
        try {
            await openLiveSession(client, FAKE_TOKEN, CAMERA_UUID);
        } catch (err: unknown) {
            threw = true;
            expect(err).to.be.instanceOf(CameraOfflineError);
        }
        expect(threw).to.be.true;
    });

    // ── Test 9: 500 → LiveSessionError ────────────────────────────────────────
    it("(9) HTTP 500 → throws LiveSessionError", async () => {
        const { client } = makeClient({ status: 500, data: "Internal Server Error" });

        let threw = false;
        try {
            await openLiveSession(client, FAKE_TOKEN, CAMERA_UUID);
        } catch (err: unknown) {
            threw = true;
            expect(err).to.be.instanceOf(LiveSessionError);
            expect((err as LiveSessionError).message).to.include("500");
        }
        expect(threw).to.be.true;
    });

    // ── Test 10: network error (axios throws) → LiveSessionError ──────────────
    it("(10) Network error (axios rejects) → throws LiveSessionError", async () => {
        const networkErr = new Error("ECONNREFUSED connect ECONNREFUSED");
        const putStub = sinon.stub().rejects(networkErr);
        const client = { put: putStub, delete: sinon.stub() } as unknown as AxiosInstance;

        let threw = false;
        try {
            await openLiveSession(client, FAKE_TOKEN, CAMERA_UUID);
        } catch (err: unknown) {
            threw = true;
            expect(err).to.be.instanceOf(LiveSessionError);
            expect((err as LiveSessionError).message).to.include("network error");
            expect((err as LiveSessionError).cause).to.equal(networkErr);
        }
        expect(threw).to.be.true;
    });

    // ── Test 11: 200 but missing creds → LiveSessionError (non-LOCAL) ─────────
    it("(11) 200 but response missing user/password/urls → throws LiveSessionError", async () => {
        const { client } = makeClient({ status: 200, data: { bufferingTime: 1000 } });

        let threw = false;
        try {
            await openLiveSession(client, FAKE_TOKEN, CAMERA_UUID);
        } catch (err: unknown) {
            threw = true;
            expect(err).to.be.instanceOf(LiveSessionError);
        }
        expect(threw).to.be.true;
    });
});

// ── closeLiveSession ───────────────────────────────────────────────────────────

describe("closeLiveSession()", () => {
    // ── Test 12: happy path 200 ───────────────────────────────────────────────
    it("(12) DELETE 200 → resolves without throw", async () => {
        const { client, deleteStub } = makeClient(
            { status: 200, data: {} },
            { status: 200, data: {} },
        );

        let threw = false;
        try {
            await closeLiveSession(client, FAKE_TOKEN, CAMERA_UUID);
        } catch {
            threw = true;
        }
        expect(threw).to.be.false;
        expect(deleteStub.calledOnce).to.be.true;
        const [calledUrl, calledOpts] = deleteStub.firstCall.args as [
            string,
            { headers: Record<string, string> },
        ];
        expect(calledUrl).to.include(`/v11/video_inputs/${CAMERA_UUID}/connection`);
        expect(calledOpts.headers["Authorization"]).to.equal(`Bearer ${FAKE_TOKEN}`);
    });

    // ── Test 13: 404 (already closed) → no throw ─────────────────────────────
    it("(13) DELETE 404 (already closed) → resolves without throw", async () => {
        const { client } = makeClient(
            { status: 200, data: {} },
            { status: 404, data: { error: "Not Found" } },
        );

        let threw = false;
        try {
            await closeLiveSession(client, FAKE_TOKEN, CAMERA_UUID);
        } catch {
            threw = true;
        }
        expect(threw).to.be.false;
    });

    // ── Test 14: network error → resolves without throw (best-effort) ─────────
    it("(14) DELETE network error → resolves without throw (best-effort cleanup)", async () => {
        const deleteStub = sinon.stub().rejects(new Error("ECONNRESET"));
        const client = { put: sinon.stub(), delete: deleteStub } as unknown as AxiosInstance;

        let threw = false;
        try {
            await closeLiveSession(client, FAKE_TOKEN, CAMERA_UUID);
        } catch {
            threw = true;
        }
        expect(threw).to.be.false;
    });
});
