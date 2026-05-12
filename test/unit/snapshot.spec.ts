/**
 * Unit tests for src/lib/snapshot.ts
 *
 * Tests snapshot fetching via Cloud-Proxy URL with HTTP Digest auth (LOCAL)
 * and plain GET (REMOTE). Mirrors HA camera.py async_camera_image() behavior.
 *
 * Framework: Mocha + Chai
 * Mocking:   axios.defaults.adapter (same pattern as digest.spec.ts)
 *
 * Reference: HA camera.py lines ~615-680 (LOCAL Digest + REMOTE plain GET)
 */

import { expect } from "chai";
import axios, {
    type AxiosAdapter,
    type InternalAxiosRequestConfig,
    type AxiosResponse,
    type AxiosResponseHeaders,
} from "axios";

import { fetchSnapshot, buildSnapshotUrl, SnapshotError } from "../../src/lib/snapshot";

// ── Adapter helpers ────────────────────────────────────────────────────────────

interface FakeResponseShape {
    status: number;
    headers: Record<string, string>;
    data: Buffer;
}

/** Build a minimal fake adapter response */
function makeAdapter(responses: FakeResponseShape[]): AxiosAdapter {
    let callIndex = 0;
    return (config: InternalAxiosRequestConfig): Promise<AxiosResponse> => {
        const resp = responses[Math.min(callIndex++, responses.length - 1)];
        return Promise.resolve({
            status: resp.status,
            statusText: String(resp.status),
            headers: resp.headers as unknown as AxiosResponseHeaders,
            config,
            data: resp.data,
            request: {},
        } as AxiosResponse);
    };
}

/** Install a fake adapter, run fn, restore original */
async function withAdapter<T>(adapter: AxiosAdapter, fn: () => Promise<T>): Promise<T> {
    const original = axios.defaults.adapter;
    axios.defaults.adapter = adapter;
    try {
        return await fn();
    } finally {
        axios.defaults.adapter = original;
    }
}

/** Standard 200 image/jpeg response */
function resp200Image(body: Buffer = Buffer.from("JPEG_BYTES")): FakeResponseShape {
    return {
        status: 200,
        headers: { "content-type": "image/jpeg" },
        data: body,
    };
}

/** Standard 401 Digest challenge (used by digestRequest internally) */
function resp401Digest(): FakeResponseShape {
    return {
        status: 401,
        headers: {
            "www-authenticate": 'Digest realm="Cam", nonce="nonce123", qop="auth", algorithm=MD5',
        },
        data: Buffer.from(""),
    };
}

const LOCAL_URL = "https://192.0.2.1:443/snap.jpg?JpegSize=1206";
const REMOTE_URL = "https://proxy-12.live.cbs.boschsecurity.com:8443/HASH123/snap.jpg?JpegSize=1206";
const JPEG_BYTES = Buffer.from("\xFF\xD8\xFF\xE0FAKEJPEG");

// ── fetchSnapshot() ────────────────────────────────────────────────────────────

describe("fetchSnapshot()", () => {
    // ── Test 1: LOCAL happy path ────────────────────────────────────────────────
    it("(1) LOCAL happy path: digestRequest returns 200 + image/jpeg → returns Buffer", async () => {
        // digestRequest sends 2 requests: initial (gets 401) + authenticated (gets 200)
        const adapter = makeAdapter([resp401Digest(), resp200Image(JPEG_BYTES)]);

        const result = await withAdapter(adapter, () =>
            fetchSnapshot(LOCAL_URL, "LOCAL", "cbs-user", "secret"),
        );

        expect(Buffer.isBuffer(result)).to.be.true;
        expect(result).to.deep.equal(JPEG_BYTES);
    });

    // ── Test 2: REMOTE happy path ───────────────────────────────────────────────
    it("(2) REMOTE happy path: plain axios GET returns 200 + image/jpeg → returns Buffer", async () => {
        // REMOTE: single GET, no Digest challenge
        const adapter = makeAdapter([resp200Image(JPEG_BYTES)]);

        const result = await withAdapter(adapter, () =>
            fetchSnapshot(REMOTE_URL, "REMOTE", "", ""),
        );

        expect(Buffer.isBuffer(result)).to.be.true;
        expect(result).to.deep.equal(JPEG_BYTES);
    });

    // ── Test 3: 404 → SnapshotError ────────────────────────────────────────────
    it("(3) 404 response → throws SnapshotError", async () => {
        // REMOTE: non-200 status
        const adapter = makeAdapter([
            { status: 404, headers: { "content-type": "text/html" }, data: Buffer.from("Not Found") },
        ]);

        let threw = false;
        try {
            await withAdapter(adapter, () =>
                fetchSnapshot(REMOTE_URL, "REMOTE", "", ""),
            );
        } catch (err: unknown) {
            threw = true;
            expect(err).to.be.instanceOf(SnapshotError);
            expect((err as SnapshotError).message).to.match(/HTTP 404/);
        }
        expect(threw).to.be.true;
    });

    // ── Test 4: 500 → SnapshotError ────────────────────────────────────────────
    it("(4) 500 response → throws SnapshotError", async () => {
        const adapter = makeAdapter([
            { status: 500, headers: {}, data: Buffer.from("Internal Server Error") },
        ]);

        let threw = false;
        try {
            await withAdapter(adapter, () =>
                fetchSnapshot(REMOTE_URL, "REMOTE", "", ""),
            );
        } catch (err: unknown) {
            threw = true;
            expect(err).to.be.instanceOf(SnapshotError);
            expect((err as SnapshotError).message).to.match(/HTTP 500/);
        }
        expect(threw).to.be.true;
    });

    // ── Test 5: 200 + text/html → SnapshotError ────────────────────────────────
    it("(5) 200 with Content-Type text/html → throws SnapshotError (not image)", async () => {
        const adapter = makeAdapter([
            {
                status: 200,
                headers: { "content-type": "text/html; charset=utf-8" },
                data: Buffer.from("<html>Login required</html>"),
            },
        ]);

        let threw = false;
        try {
            await withAdapter(adapter, () =>
                fetchSnapshot(REMOTE_URL, "REMOTE", "", ""),
            );
        } catch (err: unknown) {
            threw = true;
            expect(err).to.be.instanceOf(SnapshotError);
            expect((err as SnapshotError).message).to.match(/non-image Content-Type/i);
        }
        expect(threw).to.be.true;
    });

    // ── Test 6: 200 + image but empty body → SnapshotError ─────────────────────
    it("(6) 200 + image/jpeg but empty body → throws SnapshotError", async () => {
        const adapter = makeAdapter([
            {
                status: 200,
                headers: { "content-type": "image/jpeg" },
                data: Buffer.from(""),
            },
        ]);

        let threw = false;
        try {
            await withAdapter(adapter, () =>
                fetchSnapshot(REMOTE_URL, "REMOTE", "", ""),
            );
        } catch (err: unknown) {
            threw = true;
            expect(err).to.be.instanceOf(SnapshotError);
            expect((err as SnapshotError).message).to.match(/empty body/i);
        }
        expect(threw).to.be.true;
    });

    // ── Test 7: network timeout → SnapshotError ─────────────────────────────────
    it("(7) network timeout → throws SnapshotError", async () => {
        const original = axios.defaults.adapter;
        const timeoutErr = Object.assign(new Error("timeout of 6000ms exceeded"), {
            code: "ECONNABORTED",
        });
        axios.defaults.adapter = (() => Promise.reject(timeoutErr)) as unknown as AxiosAdapter;

        let threw = false;
        try {
            await fetchSnapshot(REMOTE_URL, "REMOTE", "", "", { timeout: 6000 });
        } catch (err: unknown) {
            threw = true;
            expect(err).to.be.instanceOf(SnapshotError);
            expect((err as SnapshotError).message).to.match(/network error/i);
        } finally {
            axios.defaults.adapter = original;
        }
        expect(threw).to.be.true;
    });

    // ── Test 8: LOCAL 404 after Digest auth → SnapshotError ────────────────────
    it("(8) LOCAL: 404 after Digest auth → throws SnapshotError", async () => {
        const adapter = makeAdapter([
            resp401Digest(),
            { status: 404, headers: {}, data: Buffer.from("") },
        ]);

        let threw = false;
        try {
            await withAdapter(adapter, () =>
                fetchSnapshot(LOCAL_URL, "LOCAL", "cbs-user", "secret"),
            );
        } catch (err: unknown) {
            threw = true;
            expect(err).to.be.instanceOf(SnapshotError);
            expect((err as SnapshotError).message).to.match(/HTTP 404/);
        }
        expect(threw).to.be.true;
    });
});

// ── buildSnapshotUrl() ─────────────────────────────────────────────────────────

describe("buildSnapshotUrl()", () => {
    // ── Test 8 (spec): bare proxy URL → appends /snap.jpg?JpegSize=1206 ─────────
    it("(8) bare proxy URL → appends /snap.jpg?JpegSize=1206", () => {
        const url = buildSnapshotUrl("https://192.0.2.1:443");
        expect(url).to.equal("https://192.0.2.1:443/snap.jpg?JpegSize=1206");
    });

    // ── Test 9 (spec): URL already ending /snap.jpg → just appends query ─────────
    it("(9) URL already ending /snap.jpg → appends ?JpegSize=1206 (no duplicate path)", () => {
        const url = buildSnapshotUrl("https://proxy-12.live.cbs.boschsecurity.com/HASH/snap.jpg");
        expect(url).to.equal(
            "https://proxy-12.live.cbs.boschsecurity.com/HASH/snap.jpg?JpegSize=1206",
        );
    });

    // ── Test 10 (spec): custom JpegSize ──────────────────────────────────────────
    it("(10) custom JpegSize=640 → uses that value", () => {
        const url = buildSnapshotUrl("https://192.0.2.1:443", 640);
        expect(url).to.equal("https://192.0.2.1:443/snap.jpg?JpegSize=640");
    });

    it("(11) trailing slash on base URL is stripped before appending path", () => {
        const url = buildSnapshotUrl("https://192.0.2.1:443/");
        expect(url).to.equal("https://192.0.2.1:443/snap.jpg?JpegSize=1206");
    });

    it("(12) remote proxy URL with path hash → appends /snap.jpg", () => {
        const url = buildSnapshotUrl(
            "https://proxy-12.live.cbs.boschsecurity.com:8443/HASH123",
            320,
        );
        expect(url).to.equal(
            "https://proxy-12.live.cbs.boschsecurity.com:8443/HASH123/snap.jpg?JpegSize=320",
        );
    });
});
