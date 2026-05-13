/**
 * Unit tests for src/lib/rcp.ts
 *
 * Covers:
 *   1.  buildRcpFrame()              — param struct + payload normalisation
 *   2.  buildSetPrivacyFrame(true)   — correct command, direction, payload
 *   3.  buildSetPrivacyFrame(false)  — off payload
 *   4.  buildSetLightFrame(true)     — CMD_LIGHT + WRITE + "0x01"
 *   5.  buildSetLightFrame(false)    — off payload
 *   6.  buildSetImageRotationFrame() — CMD_IMAGE_ROTATION + WRITE
 *   7.  buildGetSnapshotFrame()      — CMD_SNAPSHOT + READ, no payload
 *   8.  parseRcpResponse()           — valid <payload>HEX</payload>
 *   9.  parseRcpResponse()           — valid <str>HEX</str> tag
 *  10.  parseRcpResponse()           — <err> tag throws RcpError
 *  11.  parseRcpResponse()           — raw binary (JPEG) returned as-is
 *  12.  parseRcpResponse()           — empty buffer throws
 *  13.  Round-trip: buildSetPrivacyFrame → parseRcpResponse (simulated echo)
 *  14.  sendRcpCommand()             — happy path (mocked axios)
 *  15.  sendRcpCommand()             — HTTP 401 throws RcpNetworkError
 *  16.  sendRcpCommand()             — RCP <err> propagates as RcpError
 *
 * Protocol reference (from Python rcp.py):
 *   - Bosch RCP+ is HTTP GET to /rcp.xml with URL query params
 *   - direction: "READ" | "WRITE"
 *   - type:      "P_OCTET" | "P_BYTE" | "T_WORD" | "T_DWORD"
 *   - payload:   hex string, normalised to "0x…" prefix
 *   - Response:  XML with <payload>HEX</payload> or <str>HEX</str> or <err>CODE</err>
 *                or raw binary (non-XML, e.g. JPEG from 0x099e)
 */

import { expect } from "chai";
import * as sinon from "sinon";
import axios from "axios";

import {
    buildRcpFrame,
    buildSetPrivacyFrame,
    buildSetLightFrame,
    buildSetImageRotationFrame,
    buildGetSnapshotFrame,
    parseRcpResponse,
    sendRcpCommand,
    RcpError,
    RcpNetworkError,
    RCP_DIRECTION_READ,
    RCP_DIRECTION_WRITE,
    RCP_TYPE_OCTET,
    CMD_PRIVACY,
    CMD_LIGHT,
    CMD_IMAGE_ROTATION,
    CMD_SNAPSHOT,
} from "../../src/lib/rcp";

import { stubAxiosSequence, stubAxiosError, restoreAxios } from "./helpers/axios-mock";

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Build a minimal RCP XML success response with a hex payload. */
function makePayloadXml(hexPayload: string): Buffer {
    return Buffer.from(`<rcp version="1.00"><payload>${hexPayload}</payload></rcp>`, "ascii");
}

/** Build a minimal RCP XML success response using the <str> tag (alt firmware). */
function makeStrXml(hexPayload: string): Buffer {
    return Buffer.from(`<rcp version="1.00"><str>${hexPayload}</str></rcp>`, "ascii");
}

/** Build a minimal RCP XML error response. */
function makeErrXml(code: string): Buffer {
    return Buffer.from(`<rcp version="1.00"><err>${code}</err></rcp>`, "ascii");
}

// ── 1. buildRcpFrame ───────────────────────────────────────────────────────────

describe("buildRcpFrame()", () => {
    it("returns correct command, type, direction", () => {
        const p = buildRcpFrame("0x0808", RCP_TYPE_OCTET, RCP_DIRECTION_WRITE, "00010000");
        expect(p.command).to.equal("0x0808");
        expect(p.type).to.equal("P_OCTET");
        expect(p.direction).to.equal("WRITE");
    });

    it("normalises payload without 0x prefix to 0x…", () => {
        const p = buildRcpFrame("0x099e", RCP_TYPE_OCTET, RCP_DIRECTION_WRITE, "deadbeef");
        expect(p.payload).to.equal("0xdeadbeef");
    });

    it("leaves payload with existing 0x prefix unchanged", () => {
        const p = buildRcpFrame("0x099e", RCP_TYPE_OCTET, RCP_DIRECTION_WRITE, "0xdeadbeef");
        expect(p.payload).to.equal("0xdeadbeef");
    });

    it("omits payload key for READ commands with no payload", () => {
        const p = buildRcpFrame("0x099e", RCP_TYPE_OCTET, RCP_DIRECTION_READ);
        expect(p.payload).to.be.undefined;
    });

    it("sets direction READ for read frames", () => {
        const p = buildRcpFrame("0x099e", RCP_TYPE_OCTET, RCP_DIRECTION_READ);
        expect(p.direction).to.equal("READ");
    });
});

// ── 2-3. buildSetPrivacyFrame ──────────────────────────────────────────────────

describe("buildSetPrivacyFrame()", () => {
    it("enabled=true → command 0x0808, WRITE, payload 00010000", () => {
        const p = buildSetPrivacyFrame(true);
        expect(p.command).to.equal(CMD_PRIVACY);
        expect(p.direction).to.equal(RCP_DIRECTION_WRITE);
        expect(p.type).to.equal(RCP_TYPE_OCTET);
        // Privacy mask payload: 4 bytes, byte[1]=1 means ON
        // Python: "00010000" → normalised to "0x00010000"
        expect(p.payload).to.equal("0x00010000");
    });

    it("enabled=false → payload 00000000 (all bytes zero)", () => {
        const p = buildSetPrivacyFrame(false);
        expect(p.payload).to.equal("0x00000000");
    });
});

// ── 4-5. buildSetLightFrame ────────────────────────────────────────────────────

describe("buildSetLightFrame()", () => {
    it("enabled=true → command 0x099f, WRITE, payload 0x01", () => {
        const p = buildSetLightFrame(true);
        expect(p.command).to.equal(CMD_LIGHT);
        expect(p.direction).to.equal(RCP_DIRECTION_WRITE);
        expect(p.payload).to.equal("0x01");
    });

    it("enabled=false → payload 0x00", () => {
        const p = buildSetLightFrame(false);
        expect(p.payload).to.equal("0x00");
    });
});

// ── 6. buildSetImageRotationFrame ─────────────────────────────────────────────

describe("buildSetImageRotationFrame()", () => {
    it("rotated180=true → command 0x0810, WRITE, payload 0x01", () => {
        const p = buildSetImageRotationFrame(true);
        expect(p.command).to.equal(CMD_IMAGE_ROTATION);
        expect(p.direction).to.equal(RCP_DIRECTION_WRITE);
        expect(p.payload).to.equal("0x01");
    });

    it("rotated180=false → payload 0x00", () => {
        const p = buildSetImageRotationFrame(false);
        expect(p.payload).to.equal("0x00");
    });
});

// ── 7. buildGetSnapshotFrame ───────────────────────────────────────────────────

describe("buildGetSnapshotFrame()", () => {
    it("produces READ frame for command 0x099e with no payload", () => {
        const p = buildGetSnapshotFrame();
        expect(p.command).to.equal(CMD_SNAPSHOT);
        expect(p.direction).to.equal(RCP_DIRECTION_READ);
        expect(p.type).to.equal(RCP_TYPE_OCTET);
        expect(p.payload).to.be.undefined;
    });
});

// ── 8-12. parseRcpResponse ─────────────────────────────────────────────────────

describe("parseRcpResponse()", () => {
    it("parses <payload>HEX</payload> and returns correct bytes", () => {
        // Privacy mask response: 4 bytes where byte[1]=1 means ON
        // hex: 00010000 → bytes [0x00, 0x01, 0x00, 0x00]
        const raw = makePayloadXml("00010000");
        const result = parseRcpResponse(raw, "0x0d00");
        expect(result.payload).to.be.instanceOf(Buffer);
        expect(result.payload.length).to.equal(4);
        expect(result.payload[0]).to.equal(0x00);
        expect(result.payload[1]).to.equal(0x01);
        expect(result.payload[2]).to.equal(0x00);
        expect(result.payload[3]).to.equal(0x00);
        expect(result.error).to.be.undefined;
        expect(result.rawBinary).to.be.undefined;
    });

    it("parses <str>HEX</str> tag (alternate firmware format)", () => {
        // Some firmware versions return payload in <str> instead of <payload>
        const raw = makeStrXml("deadbeef");
        const result = parseRcpResponse(raw, "0x0c22");
        expect(result.payload.toString("hex")).to.equal("deadbeef");
    });

    it("throws RcpError for <err> response", () => {
        const raw = makeErrXml("0x0c0d");
        expect(() => parseRcpResponse(raw, "0x0808"))
            .to.throw(RcpError)
            .that.satisfies((e: RcpError) => e.code === "0x0c0d" && e.command === "0x0808");
    });

    it("returns rawBinary=true for non-XML binary data (JPEG from 0x099e)", () => {
        // JPEG starts with FF D8, not '<' (0x3c)
        const jpegMagic = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
        const result = parseRcpResponse(jpegMagic, "0x099e");
        expect(result.rawBinary).to.equal(true);
        expect(result.payload).to.equal(jpegMagic);
    });

    it("throws on empty buffer", () => {
        expect(() => parseRcpResponse(Buffer.alloc(0), "0x099e")).to.throw(/empty response/);
    });

    it("returns empty payload for XML with no payload/str/err tags", () => {
        const xml = Buffer.from("<rcp version='1.00'><ok/></rcp>", "ascii");
        const result = parseRcpResponse(xml, "0xff0d");
        expect(result.payload.length).to.equal(0);
        expect(result.error).to.be.undefined;
    });
});

// ── 13. Round-trip ─────────────────────────────────────────────────────────────

describe("round-trip: build → parse", () => {
    it("buildSetPrivacyFrame(true) payload is parseable as 4-byte privacy mask", () => {
        const params = buildSetPrivacyFrame(true);
        // Simulate what the camera would echo back in an XML ACK
        // Payload in params is "0x00010000" → strip "0x" → hex "00010000"
        const hexPayload = (params.payload as string).replace(/^0x/, "");
        const responseXml = makePayloadXml(hexPayload);
        const result = parseRcpResponse(responseXml, params.command);
        expect(result.payload.length).to.equal(4);
        expect(result.payload[1]).to.equal(0x01); // byte[1] = privacy ON
    });

    it("buildSetPrivacyFrame(false) round-trips to byte[1]=0x00", () => {
        const params = buildSetPrivacyFrame(false);
        const hexPayload = (params.payload as string).replace(/^0x/, "");
        const responseXml = makePayloadXml(hexPayload);
        const result = parseRcpResponse(responseXml, params.command);
        expect(result.payload[1]).to.equal(0x00); // byte[1] = privacy OFF
    });
});

// ── 14-16. sendRcpCommand ──────────────────────────────────────────────────────

describe("sendRcpCommand()", () => {
    afterEach(() => {
        restoreAxios();
    });

    it("happy path: returns parsed payload from XML response", async () => {
        const responseXml = makePayloadXml("00010000");
        stubAxiosSequence([{ status: 200, data: responseXml }]);

        const params = buildSetPrivacyFrame(true);
        const result = await sendRcpCommand(
            axios as unknown as Parameters<typeof sendRcpCommand>[0],
            "http://192.0.2.10/rcp.xml",
            params,
        );

        expect(result.payload.length).to.equal(4);
        expect(result.payload[1]).to.equal(0x01);
    });

    it("HTTP 401 throws RcpNetworkError with status 401", async () => {
        stubAxiosError(401);

        const params = buildGetSnapshotFrame();
        try {
            await sendRcpCommand(
                axios as unknown as Parameters<typeof sendRcpCommand>[0],
                "http://192.0.2.10/rcp.xml",
                params,
            );
            expect.fail("should have thrown");
        } catch (err) {
            expect(err).to.be.instanceOf(RcpNetworkError);
            expect((err as RcpNetworkError).status).to.equal(401);
        }
    });

    it("camera <err> in body propagates as RcpError (not swallowed)", async () => {
        const errXml = makeErrXml("0x90");
        stubAxiosSequence([{ status: 200, data: errXml }]);

        const params = buildGetSnapshotFrame();
        try {
            await sendRcpCommand(
                axios as unknown as Parameters<typeof sendRcpCommand>[0],
                "http://192.0.2.10/rcp.xml",
                params,
            );
            expect.fail("should have thrown");
        } catch (err) {
            expect(err).to.be.instanceOf(RcpError);
            expect((err as RcpError).code).to.equal("0x90");
        }
    });
});
