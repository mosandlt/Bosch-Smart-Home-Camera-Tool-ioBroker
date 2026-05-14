/**
 * Unit tests for the RTSP-aware Digest auth proxy helper.
 *
 * Tests cover:
 *   - Pure parsing helpers (request/response framing, header lookup)
 *   - Authorization header injection at the right buffer offset
 *   - Live state machine: DETECTING → AUTH_NEED → AUTH_RESPONDING →
 *     INJECTING, plus the back-compat PASSTHROUGH path when the client
 *     already supplies its own Authorization header.
 *
 * The state-machine tests use raw EventEmitter-based mock sockets — no
 * real TCP is opened — so the suite stays fast and deterministic.
 */

import { expect } from "chai";
import { EventEmitter } from "node:events";

import {
    attachRtspAuthHandler,
    findRtspMessageEnd,
    parseRequestStartLine,
    parseResponseStatus,
    extractWwwAuthenticate,
    hasAuthorizationHeader,
    injectAuthHeader,
} from "../../build/lib/rtsp_auth";

// ── Pure helpers ──────────────────────────────────────────────────────────────

describe("rtsp_auth — pure helpers", () => {
    it("findRtspMessageEnd: returns offset right after \\r\\n\\r\\n", () => {
        const buf = Buffer.from("OPTIONS rtsp://x/y RTSP/1.0\r\nCSeq: 1\r\n\r\n", "utf-8");
        const end = findRtspMessageEnd(buf);
        expect(end, "offset after header terminator").to.equal(buf.length);
    });

    it("findRtspMessageEnd: returns -1 for incomplete buffers", () => {
        const buf = Buffer.from("OPTIONS rtsp://x/y RTSP/1.0\r\nCSeq: 1\r\n", "utf-8");
        expect(findRtspMessageEnd(buf)).to.equal(-1);
    });

    it("parseRequestStartLine: extracts method + URI from first line", () => {
        const buf = Buffer.from(
            "DESCRIBE rtsp://192.0.2.10:5544/rtsp_tunnel?inst=1 RTSP/1.0\r\nCSeq: 2\r\n\r\n",
            "utf-8",
        );
        const parsed = parseRequestStartLine(buf);
        expect(parsed?.method).to.equal("DESCRIBE");
        expect(parsed?.uri).to.equal("rtsp://192.0.2.10:5544/rtsp_tunnel?inst=1");
    });

    it("parseRequestStartLine: returns null for garbage input", () => {
        const buf = Buffer.from("not an rtsp request\r\n\r\n", "utf-8");
        expect(parseRequestStartLine(buf)).to.equal(null);
    });

    it("parseResponseStatus: extracts numeric status from RTSP response", () => {
        const buf = Buffer.from(
            'RTSP/1.0 401 Unauthorized\r\nWWW-Authenticate: Digest realm="bosch", nonce="abc"\r\n\r\n',
            "utf-8",
        );
        expect(parseResponseStatus(buf)).to.equal(401);
    });

    it("parseResponseStatus: returns null for non-RTSP responses", () => {
        expect(parseResponseStatus(Buffer.from("HTTP/1.1 200 OK\r\n\r\n"))).to.equal(null);
    });

    it("extractWwwAuthenticate: case-insensitive header lookup", () => {
        const buf = Buffer.from(
            'RTSP/1.0 401 Unauthorized\r\nCSeq: 1\r\nwww-authenticate: Digest realm="bosch", nonce="abc123"\r\n\r\n',
            "utf-8",
        );
        const v = extractWwwAuthenticate(buf);
        expect(v).to.equal('Digest realm="bosch", nonce="abc123"');
    });

    it("extractWwwAuthenticate: returns null when header absent", () => {
        const buf = Buffer.from("RTSP/1.0 200 OK\r\nCSeq: 1\r\n\r\n", "utf-8");
        expect(extractWwwAuthenticate(buf)).to.equal(null);
    });

    it("hasAuthorizationHeader: detects header (case-insensitive)", () => {
        const yes = Buffer.from(
            'OPTIONS rtsp://x/y RTSP/1.0\r\nCSeq: 1\r\nauthorization: Digest username="u"\r\n\r\n',
            "utf-8",
        );
        const no = Buffer.from("OPTIONS rtsp://x/y RTSP/1.0\r\nCSeq: 1\r\n\r\n", "utf-8");
        expect(hasAuthorizationHeader(yes)).to.equal(true);
        expect(hasAuthorizationHeader(no)).to.equal(false);
    });

    it("injectAuthHeader: inserts Authorization before the empty terminator line", () => {
        const req = Buffer.from(
            "DESCRIBE rtsp://x/y RTSP/1.0\r\nCSeq: 2\r\nUser-Agent: VLC\r\n\r\n",
            "utf-8",
        );
        const out = injectAuthHeader(req, 'Digest username="u", response="r"').toString("utf-8");
        expect(out).to.include('Authorization: Digest username="u", response="r"');
        expect(out.endsWith("\r\n\r\n"), "buffer still ends with header terminator").to.equal(
            true,
        );
        // CSeq, User-Agent, and the new Authorization header all present
        expect(out.match(/\r\n/g)?.length, "exactly 4 \\r\\n lines (3 headers + terminator)")
            .to.be.greaterThanOrEqual(4);
    });
});

// ── State machine ─────────────────────────────────────────────────────────────

/**
 * Minimal duplex mock that satisfies the bits of `net.Socket` /
 * `tls.TLSSocket` the auth handler actually uses: `on("data", …)`,
 * `write(buf)`, and `destroyed`. Everything else is unused.
 */
class FakeSocket extends EventEmitter {
    public writes: Buffer[] = [];
    public destroyed = false;
    write(buf: Buffer | string): boolean {
        this.writes.push(Buffer.isBuffer(buf) ? buf : Buffer.from(buf, "utf-8"));
        return true;
    }
    destroy(): void {
        this.destroyed = true;
    }
    /** Concatenated write history as UTF-8 — convenience for assertions. */
    text(): string {
        return Buffer.concat(this.writes).toString("utf-8");
    }
}

function attach(client: FakeSocket, remote: FakeSocket): { logs: string[] } {
    const logs: string[] = [];
    attachRtspAuthHandler({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        clientSocket: client as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        remoteSocket: remote as any,
        digestUser: "cbs-testuser",
        digestPassword: "testpass",
        log: (level, msg) => logs.push(`[${level}] ${msg}`),
        camLabel: "EF791764",
    });
    return { logs };
}

describe("rtsp_auth — state machine", () => {
    it("PASSTHROUGH: client sends Authorization in first request → bytes piped untouched", () => {
        const client = new FakeSocket();
        const remote = new FakeSocket();
        attach(client, remote);

        const req = Buffer.from(
            'OPTIONS rtsp://x/y RTSP/1.0\r\nCSeq: 1\r\nAuthorization: Digest username="u"\r\n\r\n',
            "utf-8",
        );
        client.emit("data", req);

        expect(remote.writes.length, "request forwarded").to.equal(1);
        expect(
            remote.writes[0].equals(req),
            "request forwarded byte-identically (no injection)",
        ).to.equal(true);
    });

    it("AUTH dance: 401 from camera triggers Digest computation, second request injected, 401 swallowed", () => {
        const client = new FakeSocket();
        const remote = new FakeSocket();
        attach(client, remote);

        const optionsReq = Buffer.from(
            "OPTIONS rtsp://192.0.2.10:5544/rtsp_tunnel?inst=1 RTSP/1.0\r\nCSeq: 1\r\n\r\n",
            "utf-8",
        );
        client.emit("data", optionsReq);

        // First write to remote is the unchanged probe
        expect(remote.writes.length).to.equal(1);
        expect(
            remote.writes[0].equals(optionsReq),
            "first probe forwarded unchanged",
        ).to.equal(true);

        // Camera responds 401 + WWW-Authenticate
        const challenge = Buffer.from(
            'RTSP/1.0 401 Unauthorized\r\nCSeq: 1\r\nWWW-Authenticate: Digest realm="bosch", nonce="abcdef123456", qop="auth"\r\n\r\n',
            "utf-8",
        );
        remote.emit("data", challenge);

        // 401 must be SWALLOWED — client should never see it
        expect(client.writes.length, "client must not see the 401 challenge").to.equal(0);

        // Proxy must have written a second request to remote, this time WITH Authorization
        expect(remote.writes.length, "auth-retry written to remote").to.equal(2);
        const retry = remote.writes[1].toString("utf-8");
        expect(retry, "retry contains Authorization: Digest header").to.match(
            /Authorization: Digest /,
        );
        expect(retry, "retry preserves CSeq").to.include("CSeq: 1");
        expect(retry, "retry preserves request line").to.include(
            "OPTIONS rtsp://192.0.2.10:5544/rtsp_tunnel?inst=1 RTSP/1.0",
        );

        // Camera now responds 200 — proxy forwards it to client and switches to INJECTING
        const ok = Buffer.from(
            "RTSP/1.0 200 OK\r\nCSeq: 1\r\nPublic: OPTIONS, DESCRIBE, SETUP, PLAY, TEARDOWN\r\n\r\n",
            "utf-8",
        );
        remote.emit("data", ok);

        expect(client.writes.length, "client now sees the 200 response").to.equal(1);
        expect(client.writes[0].toString("utf-8"), "client got the OPTIONS 200 OK").to.include(
            "200 OK",
        );
    });

    it("INJECTING: subsequent client requests carry the cached Digest credentials", () => {
        const client = new FakeSocket();
        const remote = new FakeSocket();
        attach(client, remote);

        // Drive through the auth dance first
        client.emit(
            "data",
            Buffer.from(
                "OPTIONS rtsp://192.0.2.10:5544/rtsp_tunnel?inst=1 RTSP/1.0\r\nCSeq: 1\r\n\r\n",
                "utf-8",
            ),
        );
        remote.emit(
            "data",
            Buffer.from(
                'RTSP/1.0 401 Unauthorized\r\nCSeq: 1\r\nWWW-Authenticate: Digest realm="bosch", nonce="n0nce", qop="auth"\r\n\r\n',
                "utf-8",
            ),
        );
        remote.emit(
            "data",
            Buffer.from("RTSP/1.0 200 OK\r\nCSeq: 1\r\n\r\n", "utf-8"),
        );

        // Now the proxy is in INJECTING. Send a DESCRIBE — must arrive at remote with Authorization.
        const writesBefore = remote.writes.length;
        client.emit(
            "data",
            Buffer.from(
                "DESCRIBE rtsp://192.0.2.10:5544/rtsp_tunnel?inst=1 RTSP/1.0\r\nCSeq: 2\r\nAccept: application/sdp\r\n\r\n",
                "utf-8",
            ),
        );

        expect(
            remote.writes.length,
            "DESCRIBE forwarded to remote",
        ).to.equal(writesBefore + 1);
        const describe = remote.writes[remote.writes.length - 1].toString("utf-8");
        expect(describe, "injected Authorization on DESCRIBE").to.match(
            /Authorization: Digest /,
        );
        expect(describe, "DESCRIBE preserves CSeq").to.include("CSeq: 2");
        expect(describe, "DESCRIBE preserves Accept header").to.include(
            "Accept: application/sdp",
        );
    });

    it("Camera→client direction is byte-piped after the auth dance (RTP frames not mangled)", () => {
        const client = new FakeSocket();
        const remote = new FakeSocket();
        attach(client, remote);

        // Complete the dance
        client.emit(
            "data",
            Buffer.from("OPTIONS rtsp://x/y RTSP/1.0\r\nCSeq: 1\r\n\r\n", "utf-8"),
        );
        remote.emit(
            "data",
            Buffer.from(
                'RTSP/1.0 401 Unauthorized\r\nCSeq: 1\r\nWWW-Authenticate: Digest realm="b", nonce="n", qop="auth"\r\n\r\n',
                "utf-8",
            ),
        );
        remote.emit("data", Buffer.from("RTSP/1.0 200 OK\r\nCSeq: 1\r\n\r\n", "utf-8"));

        const writesBefore = client.writes.length;

        // Push an arbitrary binary payload from remote (simulated RTP frame)
        const rtp = Buffer.from([0x24, 0x00, 0x00, 0x10, 0xde, 0xad, 0xbe, 0xef, 0x01, 0x02]);
        remote.emit("data", rtp);

        expect(
            client.writes.length,
            "RTP bytes piped through to client",
        ).to.equal(writesBefore + 1);
        expect(
            client.writes[client.writes.length - 1].equals(rtp),
            "RTP frame forwarded byte-identically",
        ).to.equal(true);
    });
});
