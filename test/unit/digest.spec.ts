/**
 * Unit tests for src/lib/digest.ts
 *
 * RFC 7616 HTTP Digest Authentication — full coverage of:
 *   - parseDigestChallenge()
 *   - buildDigestHeader()
 *   - digestRequest() (via axios adapter stub)
 *   - digestGet() / digestPut() convenience wrappers
 *
 * Framework: Mocha + Chai + Sinon (no network I/O)
 * Mocking strategy: replace axios.defaults.adapter with a fake adapter
 * (the lowest-level hook in axios v1.x that works cleanly with ts-node).
 */

import { expect } from "chai";
import * as crypto from "crypto";
import axios from "axios";
import type {
    AxiosAdapter,
    InternalAxiosRequestConfig,
    AxiosPromise,
    AxiosResponseHeaders,
} from "axios";

import {
    parseDigestChallenge,
    buildDigestHeader,
    digestRequest,
    digestGet,
    digestPut,
} from "../../src/lib/digest";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** MD5 hex of a UTF-8 string (mirrors digest.ts internal) */
function md5(s: string): string {
    return crypto.createHash("md5").update(s, "utf-8").digest("hex");
}

/** SHA-256 hex of a UTF-8 string */
function sha256(s: string): string {
    return crypto.createHash("sha256").update(s, "utf-8").digest("hex");
}

/** Parse 'key="value"' or 'key=value' pairs from an Authorization: Digest header */
function parseAuthHeader(header: string): Record<string, string> {
    const result: Record<string, string> = {};
    const re = /(\w+)=(?:"([^"]*)"|([^,\s]+))/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(header)) !== null) {
        result[m[1]] = m[2] !== undefined ? m[2] : m[3];
    }
    return result;
}

/** Typed fake adapter that returns a resolved AxiosPromise */
type FakeAdapterFn = (config: InternalAxiosRequestConfig) => AxiosPromise;

interface FakeResponseShape {
    status: number;
    headers: Record<string, string>;
    data: Buffer;
}

/** Build a minimal fake adapter response */
function makeAdapter(responses: FakeResponseShape[]): FakeAdapterFn {
    let callIndex = 0;
    return (config: InternalAxiosRequestConfig): AxiosPromise => {
        const resp = responses[Math.min(callIndex++, responses.length - 1)];
        return Promise.resolve({
            status: resp.status,
            statusText: String(resp.status),
            headers: resp.headers as unknown as AxiosResponseHeaders,
            config,
            data: resp.data,
            request: {},
        });
    };
}

/** Install a fake adapter, run fn, restore original */
async function withAdapter<T>(adapter: FakeAdapterFn, fn: () => Promise<T>): Promise<T> {
    const original = axios.defaults.adapter;
    axios.defaults.adapter = adapter as unknown as AxiosAdapter;
    try {
        return await fn();
    } finally {
        axios.defaults.adapter = original;
    }
}

/** Fake adapter that captures each call's config + data */
interface CapturedCall {
    config: InternalAxiosRequestConfig;
}

function makeCaptureAdapter(
    responses: FakeResponseShape[],
    captures: CapturedCall[],
): FakeAdapterFn {
    let callIndex = 0;
    return (config: InternalAxiosRequestConfig): AxiosPromise => {
        captures.push({ config });
        const resp = responses[Math.min(callIndex++, responses.length - 1)];
        return Promise.resolve({
            status: resp.status,
            statusText: String(resp.status),
            headers: resp.headers as unknown as AxiosResponseHeaders,
            config,
            data: resp.data,
            request: {},
        });
    };
}

const resp401 = (wwwAuth: string): FakeResponseShape => ({
    status: 401,
    headers: { "www-authenticate": wwwAuth },
    data: Buffer.from(""),
});
const resp200 = (body = "ok"): FakeResponseShape => ({
    status: 200,
    headers: {},
    data: Buffer.from(body),
});

// ---------------------------------------------------------------------------
// 1. parseDigestChallenge()
// ---------------------------------------------------------------------------

describe("parseDigestChallenge()", () => {
    it("parses a full qop=auth MD5 challenge", () => {
        const hdr =
            'Digest realm="TestRealm", nonce="ABCD1234", qop="auth", algorithm=MD5, opaque="OP42"';
        const ch = parseDigestChallenge(hdr);
        expect(ch.realm).to.equal("TestRealm");
        expect(ch.nonce).to.equal("ABCD1234");
        expect(ch.qop).to.equal("auth");
        expect(ch.algorithm).to.equal("MD5");
        expect(ch.opaque).to.equal("OP42");
    });

    it("parses a legacy challenge without qop or opaque", () => {
        const hdr = 'Digest realm="Legacy", nonce="N1"';
        const ch = parseDigestChallenge(hdr);
        expect(ch.realm).to.equal("Legacy");
        expect(ch.nonce).to.equal("N1");
        expect(ch.qop).to.be.undefined;
        expect(ch.opaque).to.be.undefined;
        expect(ch.algorithm).to.be.undefined;
    });

    it("throws when scheme is not Digest (Basic)", () => {
        expect(() => parseDigestChallenge('Basic realm="X"')).to.throw(/Digest scheme/i);
    });

    it("throws when nonce is missing", () => {
        expect(() => parseDigestChallenge('Digest realm="X", qop="auth"')).to.throw(
            /missing required 'nonce'/i,
        );
    });

    it("parses SHA-256 algorithm correctly", () => {
        const hdr = 'Digest realm="R", nonce="N", algorithm=SHA-256, qop="auth"';
        const ch = parseDigestChallenge(hdr);
        expect(ch.algorithm).to.equal("SHA-256");
    });
});

// ---------------------------------------------------------------------------
// 2. buildDigestHeader()
// ---------------------------------------------------------------------------

describe("buildDigestHeader()", () => {
    it("(B1) computes correct MD5 response for qop=auth, verifies all header fields", () => {
        const challenge = {
            realm: "testrealm@host.com",
            nonce: "dcd98b7102dd2f0e8b11d0f600bfb0c093",
            qop: "auth",
            algorithm: "MD5",
            opaque: "5ccc069c403ebaf9f0171e9517f40e41",
        };
        const url = "http://www.nowhere.org/dir/index.html";
        const header = buildDigestHeader("GET", url, "Mufasa", "Circle Of Life", challenge);

        expect(header).to.match(/^Digest /);
        const parts = parseAuthHeader(header);

        expect(parts["username"]).to.equal("Mufasa");
        expect(parts["realm"]).to.equal("testrealm@host.com");
        expect(parts["nonce"]).to.equal("dcd98b7102dd2f0e8b11d0f600bfb0c093");
        expect(parts["uri"]).to.equal("/dir/index.html");
        expect(parts["algorithm"]).to.equal("MD5");
        expect(parts["qop"]).to.equal("auth");
        expect(parts["nc"]).to.equal("00000001");
        expect(parts["opaque"]).to.equal("5ccc069c403ebaf9f0171e9517f40e41");

        // Verify the response hash using the extracted cnonce
        const cnonce = parts["cnonce"];
        expect(cnonce).to.match(/^[0-9a-f]+$/);
        const ha1 = md5(`Mufasa:testrealm@host.com:Circle Of Life`);
        const ha2 = md5(`GET:/dir/index.html`);
        const expected = md5(`${ha1}:${challenge.nonce}:00000001:${cnonce}:auth:${ha2}`);
        expect(parts["response"]).to.equal(expected);
    });

    it("(B2) computes correct MD5 response for legacy no-qop mode", () => {
        const challenge = { realm: "realm", nonce: "nonce123" };
        const header = buildDigestHeader("GET", "http://host/path", "user", "pass", challenge);
        const parts = parseAuthHeader(header);

        // No qop or nc in legacy mode
        expect(header).not.to.include("qop=auth");
        expect(header).not.to.include(" nc=");

        const ha1 = md5(`user:realm:pass`);
        const ha2 = md5(`GET:/path`);
        expect(parts["response"]).to.equal(md5(`${ha1}:nonce123:${ha2}`));
    });

    it("(B3) computes SHA-256 response correctly", () => {
        const challenge = {
            realm: "realm",
            nonce: "N256",
            qop: "auth",
            algorithm: "SHA-256",
        };
        const header = buildDigestHeader("GET", "https://cam/rcp/", "u", "p", challenge);
        const parts = parseAuthHeader(header);

        const cnonce = parts["cnonce"];
        const ha1 = sha256(`u:realm:p`);
        const ha2 = sha256(`GET:/rcp/`);
        const expected = sha256(`${ha1}:N256:00000001:${cnonce}:auth:${ha2}`);
        expect(parts["response"]).to.equal(expected);
        expect(parts["algorithm"]).to.equal("SHA-256");
    });

    it("(B4) computes MD5-SESS: HA1 re-hashed with nonce+cnonce", () => {
        const challenge = {
            realm: "realm",
            nonce: "N",
            algorithm: "MD5-SESS",
            qop: "auth",
        };
        const header = buildDigestHeader("PUT", "https://host/res", "u", "p", challenge);
        const parts = parseAuthHeader(header);

        const cnonce = parts["cnonce"];
        const ha1base = md5(`u:realm:p`);
        const ha1sess = md5(`${ha1base}:N:${cnonce}`);
        const ha2 = md5(`PUT:/res`);
        const expected = md5(`${ha1sess}:N:00000001:${cnonce}:auth:${ha2}`);
        expect(parts["response"]).to.equal(expected);
        expect(parts["algorithm"]).to.equal("MD5-SESS");
    });

    it("(B5) omits opaque when not in challenge", () => {
        const challenge = { realm: "r", nonce: "n" };
        const header = buildDigestHeader("GET", "http://h/", "u", "p", challenge);
        expect(header).not.to.include("opaque");
    });

    it("(B6) includes opaque when present in challenge", () => {
        const challenge = { realm: "r", nonce: "n", opaque: "my-opaque" };
        const header = buildDigestHeader("GET", "http://h/", "u", "p", challenge);
        expect(header).to.include('opaque="my-opaque"');
    });

    it("(B7) extracts URI path+query from full URL", () => {
        const challenge = { realm: "r", nonce: "n" };
        const header = buildDigestHeader(
            "GET",
            "https://192.0.2.1:443/api/v1/data?foo=bar",
            "u",
            "p",
            challenge,
        );
        const parts = parseAuthHeader(header);
        expect(parts["uri"]).to.equal("/api/v1/data?foo=bar");
    });
});

// ---------------------------------------------------------------------------
// 3. digestRequest() — axios adapter stubbed
// ---------------------------------------------------------------------------

describe("digestRequest()", () => {
    it("(1) happy path: 401 challenge then 200 response with qop=auth MD5", async () => {
        const wwwAuth =
            'Digest realm="Cam", nonce="nonce1", qop="auth", algorithm=MD5, opaque="op1"';
        const captures: CapturedCall[] = [];
        const adapter = makeCaptureAdapter([resp401(wwwAuth), resp200("hello")], captures);

        const result = await withAdapter(adapter, () =>
            digestRequest("http://cam.local/api", "user", "secret"),
        );

        expect(result.status).to.equal(200);
        expect(result.data.toString()).to.equal("hello");
        expect(captures).to.have.length(2);

        const authHeader = captures[1].config.headers?.["Authorization"] as string | undefined;
        expect(authHeader).to.match(/^Digest /);
        expect(authHeader).to.include('username="user"');
        expect(authHeader).to.include('response="');
        expect(authHeader).to.include("qop=auth");
        expect(authHeader).to.include('opaque="op1"');

        // Verify no Authorization on the first request
        const firstAuth = captures[0].config.headers?.["Authorization"];
        expect(firstAuth).to.be.undefined;
    });

    it("(2) no auth needed: 200 on first attempt, only 1 request sent", async () => {
        const captures: CapturedCall[] = [];
        const adapter = makeCaptureAdapter([resp200("direct")], captures);

        const result = await withAdapter(adapter, () => digestRequest("http://h/", "u", "p"));

        expect(result.status).to.equal(200);
        expect(result.data.toString()).to.equal("direct");
        expect(captures).to.have.length(1);
    });

    it("(3) no qop (legacy mode): response hash uses ha1:nonce:ha2 only", async () => {
        const wwwAuth = 'Digest realm="LegacyRealm", nonce="leg123", algorithm=MD5';
        const captures: CapturedCall[] = [];
        const adapter = makeCaptureAdapter([resp401(wwwAuth), resp200("ok")], captures);

        await withAdapter(adapter, () => digestRequest("http://h/path", "u", "p"));

        const authHeader = captures[1].config.headers?.["Authorization"] as string;
        const parts = parseAuthHeader(authHeader);

        // No qop in legacy mode
        expect(parts["qop"]).to.be.undefined;
        expect(parts["nc"]).to.be.undefined;

        // Verify hash
        const ha1 = md5("u:LegacyRealm:p");
        const ha2 = md5("GET:/path");
        expect(parts["response"]).to.equal(md5(`${ha1}:leg123:${ha2}`));
    });

    it("(4) algorithm=MD5-SESS: HA1 is re-hashed with nonce+cnonce", async () => {
        const wwwAuth = 'Digest realm="R", nonce="sessNonce", qop="auth", algorithm=MD5-SESS';
        const captures: CapturedCall[] = [];
        const adapter = makeCaptureAdapter([resp401(wwwAuth), resp200()], captures);

        await withAdapter(adapter, () => digestRequest("http://h/p", "user", "pass"));

        const authHeader = captures[1].config.headers?.["Authorization"] as string;
        const parts = parseAuthHeader(authHeader);
        const cnonce = parts["cnonce"];

        const ha1base = md5("user:R:pass");
        const ha1sess = md5(`${ha1base}:sessNonce:${cnonce}`);
        const ha2 = md5("GET:/p");
        const expected = md5(`${ha1sess}:sessNonce:00000001:${cnonce}:auth:${ha2}`);
        expect(parts["response"]).to.equal(expected);
        expect(parts["algorithm"]).to.equal("MD5-SESS");
    });

    it("(5) algorithm=SHA-256: uses SHA-256 hash function throughout", async () => {
        const wwwAuth = 'Digest realm="R256", nonce="sha256nonce", qop="auth", algorithm=SHA-256';
        const captures: CapturedCall[] = [];
        const adapter = makeCaptureAdapter([resp401(wwwAuth), resp200()], captures);

        await withAdapter(adapter, () => digestRequest("http://h/res", "alice", "wonderland"));

        const authHeader = captures[1].config.headers?.["Authorization"] as string;
        const parts = parseAuthHeader(authHeader);
        const cnonce = parts["cnonce"];

        const ha1 = sha256("alice:R256:wonderland");
        const ha2 = sha256("GET:/res");
        const expected = sha256(`${ha1}:sha256nonce:00000001:${cnonce}:auth:${ha2}`);
        expect(parts["response"]).to.equal(expected);
        expect(parts["algorithm"]).to.equal("SHA-256");
    });

    it("(6) 401 without WWW-Authenticate header throws Error", async () => {
        const adapter = makeAdapter([{ status: 401, headers: {}, data: Buffer.from("") }]);
        let threw = false;
        try {
            await withAdapter(adapter, () => digestRequest("http://h/", "u", "p"));
        } catch (err: unknown) {
            threw = true;
            expect((err as Error).message).to.match(/401 without WWW-Authenticate/i);
        }
        expect(threw).to.be.true;
    });

    it("(7) 401 with Basic scheme throws Error (non-Digest scheme)", async () => {
        const adapter = makeAdapter([
            {
                status: 401,
                headers: { "www-authenticate": 'Basic realm="X"' },
                data: Buffer.from(""),
            },
        ]);
        let threw = false;
        try {
            await withAdapter(adapter, () => digestRequest("http://h/", "u", "p"));
        } catch (err: unknown) {
            threw = true;
            expect((err as Error).message).to.match(/Digest scheme/i);
        }
        expect(threw).to.be.true;
    });

    it("(8) malformed challenge (missing nonce) throws Error", async () => {
        const adapter = makeAdapter([
            {
                status: 401,
                headers: { "www-authenticate": 'Digest realm="X", qop="auth"' },
                data: Buffer.from(""),
            },
        ]);
        let threw = false;
        try {
            await withAdapter(adapter, () => digestRequest("http://h/", "u", "p"));
        } catch (err: unknown) {
            threw = true;
            expect((err as Error).message).to.match(/missing required 'nonce'/i);
        }
        expect(threw).to.be.true;
    });

    it("(9) wrong credentials: second response 401 is returned to caller", async () => {
        const wwwAuth = 'Digest realm="R", nonce="n", qop="auth", algorithm=MD5';
        const captures: CapturedCall[] = [];
        const adapter = makeCaptureAdapter(
            [resp401(wwwAuth), { status: 401, headers: {}, data: Buffer.from("Unauthorized") }],
            captures,
        );

        const result = await withAdapter(adapter, () => digestRequest("http://h/", "u", "wrong"));

        // digestRequest returns the 2nd response — caller decides what to do
        expect(result.status).to.equal(401);
        expect(captures).to.have.length(2);
    });

    it("(10) POST with Buffer body: body present in both requests", async () => {
        const wwwAuth = 'Digest realm="R", nonce="n", qop="auth", algorithm=MD5';
        const postBody = Buffer.from("request-body");
        const captures: CapturedCall[] = [];
        const adapter = makeCaptureAdapter([resp401(wwwAuth), resp200("created")], captures);

        const result = await withAdapter(adapter, () =>
            digestRequest("http://h/resource", "u", "p", { method: "POST", data: postBody }),
        );

        expect(result.status).to.equal(200);
        expect(captures).to.have.length(2);
        // Body forwarded in both requests
        expect(captures[0].config.data).to.deep.equal(postBody);
        expect(captures[1].config.data).to.deep.equal(postBody);
    });

    it("(11) network error: axios rejection propagates to caller", async () => {
        const networkErr = Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" });
        const original = axios.defaults.adapter;
        axios.defaults.adapter = (() => Promise.reject(networkErr)) as unknown as AxiosAdapter;
        let threw = false;
        try {
            await digestRequest("http://h/", "u", "p");
        } catch (err: unknown) {
            threw = true;
            expect((err as Error).message).to.equal("ECONNREFUSED");
        } finally {
            axios.defaults.adapter = original;
        }
        expect(threw).to.be.true;
    });
});

// ---------------------------------------------------------------------------
// 4. Convenience wrappers: digestGet / digestPut
// ---------------------------------------------------------------------------

describe("digestGet() / digestPut()", () => {
    it("(12) digestGet: sends GET request and returns 200 response", async () => {
        const captures: CapturedCall[] = [];
        const adapter = makeCaptureAdapter([resp200("body")], captures);

        const result = await withAdapter(adapter, () => digestGet("http://h/", "u", "p"));

        expect(result.status).to.equal(200);
        expect((captures[0].config.method as string).toUpperCase()).to.equal("GET");
    });

    it("(13) digestPut: sends PUT request with data, completes Digest auth exchange", async () => {
        const wwwAuth = 'Digest realm="R", nonce="n", qop="auth", algorithm=MD5';
        const putBody = Buffer.from("payload");
        const captures: CapturedCall[] = [];
        const adapter = makeCaptureAdapter(
            [resp401(wwwAuth), { status: 204, headers: {}, data: Buffer.from("") }],
            captures,
        );

        const result = await withAdapter(adapter, () =>
            digestPut("http://h/res", "u", "p", putBody),
        );

        expect(result.status).to.equal(204);
        expect((captures[1].config.method as string).toUpperCase()).to.equal("PUT");
        expect(captures[1].config.data).to.deep.equal(putBody);
        // Authorization header present on retry
        expect(captures[1].config.headers?.["Authorization"]).to.match(/^Digest /);
    });
});
