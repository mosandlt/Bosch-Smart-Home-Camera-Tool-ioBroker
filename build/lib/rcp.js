"use strict";
/**
 * Bosch RCP+ protocol — command builders and response parser.
 * Ported from Python custom_components/bosch_shc_camera/rcp.py.
 *
 * RCP+ frames are sent as HTTP GET query parameters to /rcp.xml:
 *   GET /rcp.xml?command=0x0808&direction=WRITE&type=P_OCTET&payload=0x01
 *
 * Via cloud proxy: https://proxy-NN.live.cbs.boschsecurity.com:42090/{hash}/rcp.xml
 * Via local LAN:   http://<cam-ip>/rcp.xml  (Gen2 unauthenticated, Gen1 requires Digest)
 *
 * The server responds with XML:
 *   Success: <rcp ...><payload>HEXHEX</payload></rcp>
 *            or <rcp ...><str>HEXHEX</str></rcp>  (firmware-dependent tag)
 *   Error:   <rcp ...><err>0xa0</err></rcp>
 *   Binary:  raw bytes (non-XML, e.g. JPEG from 0x099e)
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RcpNetworkError = exports.RcpError = exports.CMD_SESSION_ACK = exports.CMD_SESSION_INIT = exports.CMD_LED_DIMMER = exports.CMD_PRIVACY_MASK = exports.CMD_SNAPSHOT = exports.CMD_IMAGE_ROTATION = exports.CMD_LIGHT = exports.CMD_PRIVACY = exports.RCP_TYPE_DWORD = exports.RCP_TYPE_WORD = exports.RCP_TYPE_BYTE = exports.RCP_TYPE_OCTET = exports.RCP_DIRECTION_WRITE = exports.RCP_DIRECTION_READ = void 0;
exports.buildRcpFrame = buildRcpFrame;
exports.parseRcpResponse = parseRcpResponse;
exports.buildSetPrivacyFrame = buildSetPrivacyFrame;
exports.buildSetLightFrame = buildSetLightFrame;
exports.buildSetImageRotationFrame = buildSetImageRotationFrame;
exports.buildGetSnapshotFrame = buildGetSnapshotFrame;
exports.sendRcpCommand = sendRcpCommand;
const axios_1 = __importDefault(require("axios"));
const digest_1 = require("./digest");
// ── Direction constants (mirrors Python RCP_DIRECTION_* convention) ────────────
/** RCP direction: read a value from the camera. */
exports.RCP_DIRECTION_READ = "READ";
/** RCP direction: write a value to the camera. */
exports.RCP_DIRECTION_WRITE = "WRITE";
// ── Type constants (RCP type strings used in the HTTP query parameter) ─────────
/**
 * P_OCTET — variable-length octet string (most common type).
 * Payload is a hex string, e.g. "0x01" or "00010000".
 */
exports.RCP_TYPE_OCTET = "P_OCTET";
/**
 * P_BYTE — single byte value (0x00–0xff).
 * Payload is a 2-hex-digit string, e.g. "0x01".
 */
exports.RCP_TYPE_BYTE = "P_BYTE";
/**
 * T_WORD — 16-bit unsigned integer, big-endian.
 * Used for numeric values like LED dimmer (0x0c22).
 */
exports.RCP_TYPE_WORD = "T_WORD";
/**
 * T_DWORD — 32-bit unsigned integer, big-endian.
 */
exports.RCP_TYPE_DWORD = "T_DWORD";
// ── Known command codes ────────────────────────────────────────────────────────
/** 0x0808 — privacy mask enable/disable */
exports.CMD_PRIVACY = "0x0808";
/** 0x099f — camera light (LED) enable/disable */
exports.CMD_LIGHT = "0x099f";
/** 0x0810 — image rotation 180° enable/disable */
exports.CMD_IMAGE_ROTATION = "0x0810";
/** 0x099e — live JPEG snapshot (320×180) */
exports.CMD_SNAPSHOT = "0x099e";
/** 0x0d00 — privacy mask state (byte[1]: 1=ON, 0=OFF) */
exports.CMD_PRIVACY_MASK = "0x0d00";
/** 0x0c22 — LED dimmer level (T_WORD, 0-100) */
exports.CMD_LED_DIMMER = "0x0c22";
/** 0xff0c — RCP session init */
exports.CMD_SESSION_INIT = "0xff0c";
/** 0xff0d — RCP session confirm */
exports.CMD_SESSION_ACK = "0xff0d";
// ── Error class ────────────────────────────────────────────────────────────────
/**
 * The camera returned an RCP error code in the <err> tag.
 * Common codes:
 *   0x0c0d — session closed (re-open handshake)
 *   0x60   — not supported via local endpoint
 *   0x90   — not supported via cloud proxy
 *   0xa0   — permission denied
 */
class RcpError extends Error {
    code;
    command;
    constructor(code, command) {
        super(`RCP error ${code} for command ${command}`);
        this.code = code;
        this.command = command;
        this.name = "RcpError";
    }
}
exports.RcpError = RcpError;
/**
 * The RCP HTTP request failed (non-200 status or network error).
 */
class RcpNetworkError extends Error {
    status;
    constructor(status, message) {
        super(message);
        this.status = status;
        this.name = "RcpNetworkError";
    }
}
exports.RcpNetworkError = RcpNetworkError;
// ── Frame (param) builders ─────────────────────────────────────────────────────
/**
 * Build the URL query params for an RCP command.
 *
 * Mirrors the Python dict construction in rcp_local_read() / rcp_local_write()
 * and rcp_read(). The returned object can be passed directly as `params` to axios.
 *
 * @param command   Hex string, e.g. "0x0808"
 * @param type      RCP type string, e.g. RCP_TYPE_OCTET
 * @param direction "READ" or "WRITE"
 * @param payload   Hex payload string (optional for READ commands).
 *                  May include "0x" prefix or not — the function normalises to "0x…".
 */
function buildRcpFrame(command, type, direction, payload) {
    const params = { command, direction, type };
    if (payload !== undefined) {
        // Normalise to "0x…" prefix (Python rcp_local_write does the same check)
        params.payload = payload.toLowerCase().startsWith("0x") ? payload : `0x${payload}`;
    }
    return params;
}
/**
 * Parse the XML body returned by /rcp.xml.
 *
 * Handles three response formats (from Python rcp_read / rcp_local_read):
 *   1. <payload>HEXHEX</payload> — hex payload
 *   2. <str>HEXHEX</str>        — alternate firmware-specific tag (same content)
 *   3. <err>0xNN</err>          — error code → throws RcpError
 *   4. Raw binary (non-XML)     — e.g. JPEG bytes from 0x099e → returned as-is
 *
 * @param raw         Raw response bytes from the HTTP body
 * @param command     Command string (used in error messages only)
 * @returns           Parsed RcpResponse
 * @throws RcpError   on <err> response
 * @throws Error      on truncated / completely empty response
 */
function parseRcpResponse(raw, command = "unknown") {
    if (!raw || raw.length === 0) {
        throw new Error(`RCP: empty response for command ${command}`);
    }
    const text = raw.toString("ascii");
    // Check for error response <err>0xNN</err>
    const errMatch = text.match(/<err>(\S+)<\/err>/i);
    if (errMatch) {
        throw new RcpError(errMatch[1], command);
    }
    // Raw binary (non-XML) — e.g. JPEG from 0x099e
    // Python: `if raw and not raw.startswith(b"<")`
    if (raw[0] !== 0x3c /* '<' */) {
        return { payload: raw, rawBinary: true };
    }
    // Parse hex payload from <str>HEX</str> or <payload>HEX</payload>
    const strMatch = text.match(/<str>([0-9a-fA-F]+)<\/str>/i);
    const plMatch = text.match(/<payload>([0-9a-fA-F]+)<\/payload>/i);
    const hexString = (strMatch ?? plMatch)?.[1];
    if (hexString) {
        return { payload: Buffer.from(hexString, "hex") };
    }
    // XML response but no payload tag — return empty payload
    return { payload: Buffer.alloc(0) };
}
// ── High-level command builders ────────────────────────────────────────────────
/**
 * Build RCP params to enable or disable the privacy mask.
 *
 * Command 0x0808, direction WRITE, type P_OCTET.
 * Privacy mask payload: 4 bytes, byte[1] carries the mode.
 * Mirrors Python rcp_local_write_privacy() — payload "00010000" / "00000000".
 */
function buildSetPrivacyFrame(enabled) {
    const payload = enabled ? "00010000" : "00000000";
    return buildRcpFrame(exports.CMD_PRIVACY, exports.RCP_TYPE_OCTET, exports.RCP_DIRECTION_WRITE, payload);
}
/**
 * Build RCP params to enable or disable the camera light (LED).
 *
 * Command 0x099f, direction WRITE, type P_OCTET.
 * Payload: "0x01" (on) or "0x00" (off).
 */
function buildSetLightFrame(enabled) {
    const payload = enabled ? "01" : "00";
    return buildRcpFrame(exports.CMD_LIGHT, exports.RCP_TYPE_OCTET, exports.RCP_DIRECTION_WRITE, payload);
}
/**
 * Build RCP params to enable or disable 180° image rotation.
 *
 * Command 0x0810, direction WRITE, type P_OCTET.
 * Payload: "0x01" (rotated) or "0x00" (normal).
 */
function buildSetImageRotationFrame(rotated180) {
    const payload = rotated180 ? "01" : "00";
    return buildRcpFrame(exports.CMD_IMAGE_ROTATION, exports.RCP_TYPE_OCTET, exports.RCP_DIRECTION_WRITE, payload);
}
/**
 * Build RCP params to fetch a live JPEG snapshot.
 *
 * Command 0x099e, direction READ, type P_OCTET.
 * The camera returns a raw JPEG (non-XML binary) at 320×180 resolution.
 * Mirrors Python rcp_read(hass, rcp_base, "0x099e", session_id).
 */
function buildGetSnapshotFrame() {
    return buildRcpFrame(exports.CMD_SNAPSHOT, exports.RCP_TYPE_OCTET, exports.RCP_DIRECTION_READ);
}
/**
 * Send an RCP command to the /rcp.xml endpoint and return the parsed response.
 *
 * Mirrors Python rcp_local_read() for the local path and rcp_read() for the
 * cloud proxy path. Uses axios so callers can inject a mock for testing.
 *
 * When `auth` is provided, performs a Digest-authenticated request via the
 * helper in digest.ts (two-step 401 challenge → authenticated GET). LOCAL cams
 * (both Gen1 and Gen2) require Digest on /rcp.xml. The cloud proxy URL is
 * pre-authenticated via the URL hash and must be called WITHOUT auth.
 *
 * @param httpClient  Axios instance (used for the no-auth code path)
 * @param baseUrl     Full URL to rcp.xml, e.g. "https://192.0.2.10:443/rcp.xml"
 *                    or "https://proxy-01.live.cbs.boschsecurity.com:42090/{hash}/rcp.xml"
 * @param params      RCP params from buildRcpFrame() or the specific builders
 * @param timeoutMs   Request timeout in milliseconds (default 5000)
 * @param auth        Optional Digest credentials — required for LOCAL connection type
 * @returns           Parsed RcpResponse, or null if the server returned non-200
 * @throws RcpError   if the camera returned <err>
 * @throws RcpNetworkError on HTTP error or network failure
 */
async function sendRcpCommand(httpClient, baseUrl, params, timeoutMs = 5000, auth) {
    // Build query string from params (RCP+ uses URL-encoded GET parameters)
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null)
            qs.append(k, String(v));
    }
    const fullUrl = `${baseUrl}?${qs.toString()}`;
    try {
        if (auth) {
            // LOCAL path: Digest auth (RFC 7616 two-step)
            const resp = await (0, digest_1.digestRequest)(fullUrl, auth.user, auth.password, {
                method: "GET",
                timeout: timeoutMs,
                rejectUnauthorized: false,
            });
            if (resp.status !== 200) {
                throw new RcpNetworkError(resp.status, `RCP HTTP ${resp.status} for command ${params.command} (digest auth)`);
            }
            return parseRcpResponse(resp.data, params.command);
        }
        // REMOTE path: pre-authenticated cloud proxy URL — no auth needed
        const resp = await httpClient.get(baseUrl, {
            params,
            responseType: "arraybuffer",
            timeout: timeoutMs,
        });
        const raw = Buffer.isBuffer(resp.data)
            ? resp.data
            : Buffer.from(resp.data);
        return parseRcpResponse(raw, params.command);
    }
    catch (err) {
        if (err instanceof RcpNetworkError)
            throw err;
        if (axios_1.default.isAxiosError(err)) {
            const status = err.response?.status;
            throw new RcpNetworkError(status, `RCP HTTP ${status ?? "network error"} for command ${params.command}: ${err.message}`);
        }
        // Re-throw RcpError and other errors unchanged
        throw err;
    }
}
//# sourceMappingURL=rcp.js.map