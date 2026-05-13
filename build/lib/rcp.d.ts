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
import { type AxiosInstance } from "axios";
/** RCP direction: read a value from the camera. */
export declare const RCP_DIRECTION_READ: "READ";
/** RCP direction: write a value to the camera. */
export declare const RCP_DIRECTION_WRITE: "WRITE";
/**
 * P_OCTET — variable-length octet string (most common type).
 * Payload is a hex string, e.g. "0x01" or "00010000".
 */
export declare const RCP_TYPE_OCTET: "P_OCTET";
/**
 * P_BYTE — single byte value (0x00–0xff).
 * Payload is a 2-hex-digit string, e.g. "0x01".
 */
export declare const RCP_TYPE_BYTE: "P_BYTE";
/**
 * T_WORD — 16-bit unsigned integer, big-endian.
 * Used for numeric values like LED dimmer (0x0c22).
 */
export declare const RCP_TYPE_WORD: "T_WORD";
/**
 * T_DWORD — 32-bit unsigned integer, big-endian.
 */
export declare const RCP_TYPE_DWORD: "T_DWORD";
export type RcpDirection = typeof RCP_DIRECTION_READ | typeof RCP_DIRECTION_WRITE;
export type RcpType = typeof RCP_TYPE_OCTET | typeof RCP_TYPE_BYTE | typeof RCP_TYPE_WORD | typeof RCP_TYPE_DWORD;
/** 0x0808 — privacy mask enable/disable */
export declare const CMD_PRIVACY: "0x0808";
/** 0x099f — camera light (LED) enable/disable */
export declare const CMD_LIGHT: "0x099f";
/** 0x0810 — image rotation 180° enable/disable */
export declare const CMD_IMAGE_ROTATION: "0x0810";
/** 0x099e — live JPEG snapshot (320×180) */
export declare const CMD_SNAPSHOT: "0x099e";
/** 0x0d00 — privacy mask state (byte[1]: 1=ON, 0=OFF) */
export declare const CMD_PRIVACY_MASK: "0x0d00";
/** 0x0c22 — LED dimmer level (T_WORD, 0-100) */
export declare const CMD_LED_DIMMER: "0x0c22";
/** 0xff0c — RCP session init */
export declare const CMD_SESSION_INIT: "0xff0c";
/** 0xff0d — RCP session confirm */
export declare const CMD_SESSION_ACK: "0xff0d";
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
/**
 * The camera returned an RCP error code in the <err> tag.
 * Common codes:
 *   0x0c0d — session closed (re-open handshake)
 *   0x60   — not supported via local endpoint
 *   0x90   — not supported via cloud proxy
 *   0xa0   — permission denied
 */
export declare class RcpError extends Error {
    readonly code: string;
    readonly command: string;
    constructor(code: string, command: string);
}
/**
 * The RCP HTTP request failed (non-200 status or network error).
 */
export declare class RcpNetworkError extends Error {
    readonly status: number | undefined;
    constructor(status: number | undefined, message: string);
}
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
export declare function buildRcpFrame(command: string, type: RcpType, direction: RcpDirection, payload?: string): RcpParams;
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
export declare function parseRcpResponse(raw: Buffer, command?: string): RcpResponse;
/**
 * Build RCP params to enable or disable the privacy mask.
 *
 * Command 0x0808, direction WRITE, type P_OCTET.
 * Privacy mask payload: 4 bytes, byte[1] carries the mode.
 * Mirrors Python rcp_local_write_privacy() — payload "00010000" / "00000000".
 */
export declare function buildSetPrivacyFrame(enabled: boolean): RcpParams;
/**
 * Build RCP params to enable or disable the camera light (LED).
 *
 * Command 0x099f, direction WRITE, type P_OCTET.
 * Payload: "0x01" (on) or "0x00" (off).
 */
export declare function buildSetLightFrame(enabled: boolean): RcpParams;
/**
 * Build RCP params to enable or disable 180° image rotation.
 *
 * Command 0x0810, direction WRITE, type P_OCTET.
 * Payload: "0x01" (rotated) or "0x00" (normal).
 */
export declare function buildSetImageRotationFrame(rotated180: boolean): RcpParams;
/**
 * Build RCP params to fetch a live JPEG snapshot.
 *
 * Command 0x099e, direction READ, type P_OCTET.
 * The camera returns a raw JPEG (non-XML binary) at 320×180 resolution.
 * Mirrors Python rcp_read(hass, rcp_base, "0x099e", session_id).
 */
export declare function buildGetSnapshotFrame(): RcpParams;
/** Optional Digest auth credentials for LOCAL RCP calls. */
export interface RcpAuth {
    user: string;
    password: string;
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
export declare function sendRcpCommand(httpClient: AxiosInstance, baseUrl: string, params: RcpParams, timeoutMs?: number, auth?: RcpAuth): Promise<RcpResponse>;
//# sourceMappingURL=rcp.d.ts.map