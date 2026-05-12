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

import axios, { type AxiosInstance } from "axios";

// ── Direction constants (mirrors Python RCP_DIRECTION_* convention) ────────────

/** RCP direction: read a value from the camera. */
export const RCP_DIRECTION_READ = "READ" as const;

/** RCP direction: write a value to the camera. */
export const RCP_DIRECTION_WRITE = "WRITE" as const;

// ── Type constants (RCP type strings used in the HTTP query parameter) ─────────

/**
 * P_OCTET — variable-length octet string (most common type).
 * Payload is a hex string, e.g. "0x01" or "00010000".
 */
export const RCP_TYPE_OCTET = "P_OCTET" as const;

/**
 * P_BYTE — single byte value (0x00–0xff).
 * Payload is a 2-hex-digit string, e.g. "0x01".
 */
export const RCP_TYPE_BYTE = "P_BYTE" as const;

/**
 * T_WORD — 16-bit unsigned integer, big-endian.
 * Used for numeric values like LED dimmer (0x0c22).
 */
export const RCP_TYPE_WORD = "T_WORD" as const;

/**
 * T_DWORD — 32-bit unsigned integer, big-endian.
 */
export const RCP_TYPE_DWORD = "T_DWORD" as const;

// ── Type aliases ───────────────────────────────────────────────────────────────

export type RcpDirection = typeof RCP_DIRECTION_READ | typeof RCP_DIRECTION_WRITE;
export type RcpType = typeof RCP_TYPE_OCTET | typeof RCP_TYPE_BYTE | typeof RCP_TYPE_WORD | typeof RCP_TYPE_DWORD;

// ── Known command codes ────────────────────────────────────────────────────────

/** 0x0808 — privacy mask enable/disable */
export const CMD_PRIVACY        = "0x0808" as const;
/** 0x099f — camera light (LED) enable/disable */
export const CMD_LIGHT          = "0x099f" as const;
/** 0x0810 — image rotation 180° enable/disable */
export const CMD_IMAGE_ROTATION = "0x0810" as const;
/** 0x099e — live JPEG snapshot (320×180) */
export const CMD_SNAPSHOT       = "0x099e" as const;
/** 0x0d00 — privacy mask state (byte[1]: 1=ON, 0=OFF) */
export const CMD_PRIVACY_MASK   = "0x0d00" as const;
/** 0x0c22 — LED dimmer level (T_WORD, 0-100) */
export const CMD_LED_DIMMER     = "0x0c22" as const;
/** 0xff0c — RCP session init */
export const CMD_SESSION_INIT   = "0xff0c" as const;
/** 0xff0d — RCP session confirm */
export const CMD_SESSION_ACK    = "0xff0d" as const;

// ── RCP parameter types ────────────────────────────────────────────────────────

/**
 * RCP query parameters sent to /rcp.xml via HTTP GET.
 * All fields are strings (URL query params).
 */
export interface RcpParams {
    command: string;
    direction: RcpDirection;
    type: RcpType;
    /** Hex-encoded payload string, e.g. "0x01" or "00010000". Optional for READ. */
    payload?: string;
    /** Session ID (cloud proxy only). */
    sessionid?: string;
    /** Numeric index for multi-value commands. */
    num?: string;
}

/**
 * Parsed RCP response from the camera's XML reply.
 */
export interface RcpResponse {
    /** Payload bytes decoded from the hex string in <payload> or <str> tag. */
    payload: Buffer;
    /** Error code string if the camera returned <err>, e.g. "0xa0". Undefined on success. */
    error?: string;
    /** True when the camera returned raw binary (non-XML), e.g. a JPEG. */
    rawBinary?: boolean;
}

// ── Error class ────────────────────────────────────────────────────────────────

/**
 * The camera returned an RCP error code in the <err> tag.
 * Common codes:
 *   0x0c0d — session closed (re-open handshake)
 *   0x60   — not supported via local endpoint
 *   0x90   — not supported via cloud proxy
 *   0xa0   — permission denied
 */
export class RcpError extends Error {
    constructor(
        public readonly code: string,
        public readonly command: string,
    ) {
        super(`RCP error ${code} for command ${command}`);
        this.name = "RcpError";
    }
}

/**
 * The RCP HTTP request failed (non-200 status or network error).
 */
export class RcpNetworkError extends Error {
    constructor(
        public readonly status: number | undefined,
        message: string,
    ) {
        super(message);
        this.name = "RcpNetworkError";
    }
}

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
export function buildRcpFrame(
    command: string,
    type: RcpType,
    direction: RcpDirection,
    payload?: string,
): RcpParams {
    const params: RcpParams = { command, direction, type };
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
export function parseRcpResponse(raw: Buffer, command = "unknown"): RcpResponse {
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
    const strMatch   = text.match(/<str>([0-9a-fA-F]+)<\/str>/i);
    const plMatch    = text.match(/<payload>([0-9a-fA-F]+)<\/payload>/i);
    const hexString  = (strMatch ?? plMatch)?.[1];

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
export function buildSetPrivacyFrame(enabled: boolean): RcpParams {
    const payload = enabled ? "00010000" : "00000000";
    return buildRcpFrame(CMD_PRIVACY, RCP_TYPE_OCTET, RCP_DIRECTION_WRITE, payload);
}

/**
 * Build RCP params to enable or disable the camera light (LED).
 *
 * Command 0x099f, direction WRITE, type P_OCTET.
 * Payload: "0x01" (on) or "0x00" (off).
 */
export function buildSetLightFrame(enabled: boolean): RcpParams {
    const payload = enabled ? "01" : "00";
    return buildRcpFrame(CMD_LIGHT, RCP_TYPE_OCTET, RCP_DIRECTION_WRITE, payload);
}

/**
 * Build RCP params to enable or disable 180° image rotation.
 *
 * Command 0x0810, direction WRITE, type P_OCTET.
 * Payload: "0x01" (rotated) or "0x00" (normal).
 */
export function buildSetImageRotationFrame(rotated180: boolean): RcpParams {
    const payload = rotated180 ? "01" : "00";
    return buildRcpFrame(CMD_IMAGE_ROTATION, RCP_TYPE_OCTET, RCP_DIRECTION_WRITE, payload);
}

/**
 * Build RCP params to fetch a live JPEG snapshot.
 *
 * Command 0x099e, direction READ, type P_OCTET.
 * The camera returns a raw JPEG (non-XML binary) at 320×180 resolution.
 * Mirrors Python rcp_read(hass, rcp_base, "0x099e", session_id).
 */
export function buildGetSnapshotFrame(): RcpParams {
    return buildRcpFrame(CMD_SNAPSHOT, RCP_TYPE_OCTET, RCP_DIRECTION_READ);
}

// ── HTTP helpers ───────────────────────────────────────────────────────────────

/**
 * Send an RCP command to the /rcp.xml endpoint and return the parsed response.
 *
 * Mirrors Python rcp_local_read() for the local path and rcp_read() for the
 * cloud proxy path. Uses axios so callers can inject a mock for testing.
 *
 * @param httpClient  Axios instance (allows injection for testing)
 * @param baseUrl     Full URL to rcp.xml, e.g. "http://192.168.20.149/rcp.xml"
 *                    or "https://proxy-01.live.cbs.boschsecurity.com:42090/{hash}/rcp.xml"
 * @param params      RCP params from buildRcpFrame() or the specific builders
 * @param timeoutMs   Request timeout in milliseconds (default 5000)
 * @returns           Parsed RcpResponse, or null if the server returned non-200
 * @throws RcpError   if the camera returned <err>
 * @throws RcpNetworkError on HTTP error or network failure
 */
export async function sendRcpCommand(
    httpClient: AxiosInstance,
    baseUrl: string,
    params: RcpParams,
    timeoutMs = 5000,
): Promise<RcpResponse> {
    try {
        const resp = await httpClient.get<Buffer>(baseUrl, {
            params,
            responseType: "arraybuffer",
            timeout: timeoutMs,
        });

        const raw = Buffer.isBuffer(resp.data)
            ? resp.data
            : Buffer.from(resp.data as ArrayBuffer);

        return parseRcpResponse(raw, params.command);
    } catch (err: unknown) {
        if (axios.isAxiosError(err)) {
            const status = err.response?.status;
            throw new RcpNetworkError(
                status,
                `RCP HTTP ${status ?? "network error"} for command ${params.command}: ${err.message}`,
            );
        }
        // Re-throw RcpError and other errors unchanged
        throw err;
    }
}
