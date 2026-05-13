/**
 * Unit tests for src/lib/live_session.ts
 *
 * Tests the PUT /v11/video_inputs/{id}/connection API wrapper that returns
 * per-camera Cloud-Proxy URL + Digest credentials.
 *
 * Framework: Mocha + Chai + sinon
 * Mocking:   sinon stubs on the axios instance (httpClient.put / httpClient.delete)
 *
 * Reference: HA custom_components/bosch_shc_camera/__init__.py
 *   _try_live_connection_inner() — response shapes + error codes
 *
 * Tests:
 *  1.  AUTO (→ LOCAL) happy path: 200 LOCAL response → LiveSession with digestUser
 *  2.  LOCAL_ONLY happy path: explicit type=LOCAL → digestUser populated
 *  3.  REMOTE_ONLY happy path: 200 REMOTE response (urls[]) → proxyUrl, no digestUser
 *  4.  AUTO fallback to REMOTE: LOCAL fields absent → REMOTE parsed
 *  5.  Legacy REMOTE shape (hash+proxyHost+proxyPort) → proxyUrl assembled correctly
 *  6.  401 → throws LiveSessionError
 *  7.  404 → throws LiveSessionError
 *  8.  444 → throws SessionLimitError
 *  9.  503 → throws CameraOfflineError
 * 10.  500 / 5xx → throws LiveSessionError
 * 11.  Network error (axios throws) → throws LiveSessionError
 * 12.  Response missing proxyUrl / urls / hash → throws LiveSessionError
 * 13.  closeLiveSession happy path (2xx) → resolves without throw
 * 14.  closeLiveSession 404 (already closed) → resolves without throw
 * 15.  closeLiveSession network error → resolves without throw (best-effort)
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

const FAKE_TOKEN  = "Bearer.test.token";
const CAMERA_UUID = "EF791764-A48D-4F00-9B32-EF04BEB0DDA0";

/** Build a minimal fake AxiosInstance with stubbed put + delete */
function makeClient(
    putResponse: { status: number; data: unknown },
    deleteResponse: { status: number; data: unknown } = { status: 200, data: {} },
): { client: AxiosInstance; putStub: sinon.SinonStub; deleteStub: sinon.SinonStub } {
    const putStub    = sinon.stub().resolves(putResponse);
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
): Record<string, unknown> {
    return { user, password, urls, imageUrlScheme, bufferingTime };
}

/** REMOTE response body (urls[] shape) */
function remoteBody(
    urls = ["proxy-12.live.cbs.boschsecurity.com:42090/HASH123"],
    bufferingTime = 1000,
): Record<string, unknown> {
    return { urls, bufferingTime };
}

/** Legacy REMOTE response body (hash + proxyHost + proxyPort) */
function remoteLegacyBody(
    hash = "HASH_LEGACY",
    proxyHost = "proxy-01.live.cbs.boschsecurity.com",
    proxyPort = 42090,
): Record<string, unknown> {
    return { hash, proxyHost, proxyPort };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("openLiveSession()", () => {

    // ── Test 1: AUTO happy path → LOCAL ────────────────────────────────────────
    it("(1) AUTO mode: 200 LOCAL response → LiveSession with digestUser + proxyUrl", async () => {
        const { client } = makeClient({ status: 200, data: localBody() });

        const session: LiveSession = await openLiveSession(client, FAKE_TOKEN, CAMERA_UUID, "AUTO");

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
    });

    // ── Test 2: LOCAL_ONLY happy path ─────────────────────────────────────────
    it("(2) LOCAL_ONLY: passes type=LOCAL in body, returns LOCAL session", async () => {
        const { client, putStub } = makeClient({ status: 200, data: localBody() });

        const session = await openLiveSession(client, FAKE_TOKEN, CAMERA_UUID, "LOCAL_ONLY");

        expect(session.connectionType).to.equal("LOCAL");
        // Verify PUT body contained type=LOCAL
        const callArg = putStub.firstCall.args[2] as { headers: Record<string, string> };
        expect(putStub.firstCall.args[1]).to.deep.include({ type: "LOCAL" });
        void callArg; // suppress unused warning
    });

    // ── Test 3: REMOTE_ONLY happy path (urls[] shape) ─────────────────────────
    it("(3) REMOTE_ONLY: 200 REMOTE response (urls[]) → proxyUrl, empty digestUser", async () => {
        const { client, putStub } = makeClient({ status: 200, data: remoteBody() });

        const session = await openLiveSession(client, FAKE_TOKEN, CAMERA_UUID, "REMOTE_ONLY");

        expect(session.connectionType).to.equal("REMOTE");
        expect(session.digestUser).to.equal("");
        expect(session.digestPassword).to.equal("");
        expect(session.lanAddress).to.equal("");
        expect(session.proxyUrl).to.include("https://proxy-12.live.cbs.boschsecurity.com:42090/HASH123");
        expect(session.proxyUrl).to.include("JpegSize=1206");
        expect(session.bufferingTimeMs).to.equal(1000);
        // Verify PUT body contained type=REMOTE
        expect(putStub.firstCall.args[1]).to.deep.include({ type: "REMOTE" });
    });

    // ── Test 4: AUTO but LOCAL fields absent → REMOTE parsed from same urls[] ──
    it("(4) AUTO: response has urls[] but no user/password → parsed as REMOTE", async () => {
        // Simulate Bosch returning REMOTE even for AUTO request
        const { client } = makeClient({ status: 200, data: remoteBody(["proxy-5.live.cbs.boschsecurity.com:42090/HASHXYZ"]) });

        const session = await openLiveSession(client, FAKE_TOKEN, CAMERA_UUID, "AUTO");

        expect(session.connectionType).to.equal("REMOTE");
        expect(session.proxyUrl).to.include("HASHXYZ");
    });

    // ── Test 5: Legacy REMOTE shape (hash+proxyHost+proxyPort) ────────────────
    it("(5) Legacy REMOTE response (hash+proxyHost+proxyPort) → proxyUrl assembled", async () => {
        const { client } = makeClient({ status: 200, data: remoteLegacyBody() });

        const session = await openLiveSession(client, FAKE_TOKEN, CAMERA_UUID, "REMOTE_ONLY");

        expect(session.connectionType).to.equal("REMOTE");
        expect(session.proxyUrl).to.equal(
            "https://proxy-01.live.cbs.boschsecurity.com:42090/HASH_LEGACY/snap.jpg?JpegSize=1206",
        );
    });

    // ── Test 6: 401 → LiveSessionError ────────────────────────────────────────
    it("(6) HTTP 401 → throws LiveSessionError (token expired)", async () => {
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

    // ── Test 7: 404 → LiveSessionError ────────────────────────────────────────
    it("(7) HTTP 404 → throws LiveSessionError (camera not found)", async () => {
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

    // ── Test 8: 444 → SessionLimitError ───────────────────────────────────────
    it("(8) HTTP 444 → throws SessionLimitError", async () => {
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

    // ── Test 9: 503 → CameraOfflineError ──────────────────────────────────────
    it("(9) HTTP 503 → throws CameraOfflineError (camera offline / privacy)", async () => {
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

    // ── Test 10: 500 → LiveSessionError ──────────────────────────────────────
    it("(10) HTTP 500 → throws LiveSessionError", async () => {
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

    // ── Test 11: network error (axios throws) → LiveSessionError ─────────────
    it("(11) Network error (axios rejects) → throws LiveSessionError", async () => {
        const networkErr = new Error("ECONNREFUSED connect ECONNREFUSED");
        const putStub    = sinon.stub().rejects(networkErr);
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

    // ── Test 12: Response missing proxyUrl / urls / hash → LiveSessionError ───
    it("(12) 200 but response missing urls, hash → throws LiveSessionError", async () => {
        // Empty body — no user, no password, no urls, no hash
        const { client } = makeClient({ status: 200, data: { bufferingTime: 1000 } });

        let threw = false;
        try {
            await openLiveSession(client, FAKE_TOKEN, CAMERA_UUID);
        } catch (err: unknown) {
            threw = true;
            expect(err).to.be.instanceOf(LiveSessionError);
            expect((err as LiveSessionError).message).to.include("missing proxyUrl");
        }
        expect(threw).to.be.true;
    });

});

// ── closeLiveSession ───────────────────────────────────────────────────────────

describe("closeLiveSession()", () => {

    // ── Test 13: happy path 200 ───────────────────────────────────────────────
    it("(13) DELETE 200 → resolves without throw", async () => {
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
        const [calledUrl, calledOpts] = deleteStub.firstCall.args as [string, { headers: Record<string, string> }];
        expect(calledUrl).to.include(`/v11/video_inputs/${CAMERA_UUID}/connection`);
        expect(calledOpts.headers["Authorization"]).to.equal(`Bearer ${FAKE_TOKEN}`);
    });

    // ── Test 14: 404 (already closed) → no throw ─────────────────────────────
    it("(14) DELETE 404 (already closed) → resolves without throw", async () => {
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

    // ── Test 15: network error → resolves without throw (best-effort) ─────────
    it("(15) DELETE network error → resolves without throw (best-effort cleanup)", async () => {
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
