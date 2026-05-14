/**
 * Bosch Cloud — siren (panic_alarm) + Gen2 RGB lighting helpers.
 *
 * Two thin wrappers around `/v11/video_inputs/{id}/...` endpoints; isolated
 * from `main.ts` so the adapter class stays focused on state-tree wiring.
 *
 * Siren: Gen2 only, PUT /panic_alarm with {"status": "ON"|"OFF"} (204).
 *        Stateful — siren keeps blaring until OFF is sent. No GET endpoint;
 *        callers must track desired state locally.
 *
 * Lighting (Gen2 only): GET + PUT /v11/video_inputs/{id}/lighting/switch.
 *        Body shape:
 *           {
 *             frontLightSettings:     {brightness, color, whiteBalance},
 *             topLedLightSettings:    {brightness, color, whiteBalance},
 *             bottomLedLightSettings: {brightness, color, whiteBalance},
 *           }
 *        `color` (HEX "#RRGGBB") and `whiteBalance` (-1.0..1.0) are mutually
 *        exclusive per group — set one, the other goes null. PUT requires
 *        the full body in every call (the API rejects partial updates).
 *
 * References: HA integration `light.py` (_put_lighting_switch) and
 * `switch.py` (BoschPanicAlarmSwitch).
 */

import type { AxiosInstance } from "axios";
import { CLOUD_API } from "./auth";

/** Per-LED-group settings as returned and accepted by the lighting endpoint. */
export interface LedGroupSettings {
    /** 0..100. 0 = off. */
    brightness: number;
    /** "#RRGGBB" when in RGB mode, null when in white-balance mode. */
    color: string | null;
    /** -1.0 (warm) .. 1.0 (cold). null when in RGB mode. */
    whiteBalance: number | null;
}

/** Full body shape of GET/PUT /lighting/switch (Gen2). */
export interface LightingState {
    /**
     *
     */
    frontLightSettings: LedGroupSettings;
    /**
     *
     */
    topLedLightSettings: LedGroupSettings;
    /**
     *
     */
    bottomLedLightSettings: LedGroupSettings;
}

/** Default group settings used when the cache is empty (mirrors HA's defaults). */
const DEFAULT_GROUP: LedGroupSettings = {
    brightness: 0,
    color: null,
    whiteBalance: -1.0,
};

/** Default full lighting body — used as the seed for the first PUT after empty cache. */
export const DEFAULT_LIGHTING_STATE: LightingState = {
    frontLightSettings: { ...DEFAULT_GROUP },
    topLedLightSettings: { ...DEFAULT_GROUP },
    bottomLedLightSettings: { ...DEFAULT_GROUP },
};

/**
 * Trigger / silence the integrated 75 dB siren (Gen2 only).
 *
 * @param httpClient  Axios instance
 * @param token       Bearer access token
 * @param cameraId    Camera UUID
 * @param enabled     true → siren ON (blares until OFF), false → siren OFF
 * @returns true on HTTP 200/201/204, false on any other status / network error
 */
export async function setPanicAlarm(
    httpClient: AxiosInstance,
    token: string,
    cameraId: string,
    enabled: boolean,
): Promise<boolean> {
    try {
        const resp = await httpClient.put<unknown>(
            `${CLOUD_API}/v11/video_inputs/${cameraId}/panic_alarm`,
            { status: enabled ? "ON" : "OFF" },
            {
                headers: {
                    Authorization: `Bearer ${token}`,
                    "Content-Type": "application/json",
                    Accept: "application/json",
                },
                validateStatus: () => true,
            },
        );
        return resp.status === 200 || resp.status === 201 || resp.status === 204;
    } catch {
        return false;
    }
}

/**
 * Fetch the current Gen2 lighting state. Returns null on any non-200 or
 * unparseable response so callers can fall back to cached / default state.
 *
 * @param httpClient
 * @param token
 * @param cameraId
 */
export async function fetchLightingState(
    httpClient: AxiosInstance,
    token: string,
    cameraId: string,
): Promise<LightingState | null> {
    try {
        const resp = await httpClient.get<unknown>(
            `${CLOUD_API}/v11/video_inputs/${cameraId}/lighting/switch`,
            {
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: "application/json",
                },
                validateStatus: () => true,
            },
        );
        if (resp.status !== 200 || typeof resp.data !== "object" || resp.data === null) {
            return null;
        }
        return normaliseLightingState(resp.data as Record<string, unknown>);
    } catch {
        return null;
    }
}

/**
 * Send a full lighting state to the camera. Bosch's API requires all three
 * light groups in the body — callers must merge their delta into a cached
 * full state before passing it here.
 *
 * @param httpClient
 * @param token
 * @param cameraId
 * @param state
 * @returns the response body parsed into a LightingState on success, or
 * `null` on any non-2xx. The caller should update its cache with this
 * return value to keep the local view in sync with what the camera now
 * reports.
 */
export async function putLightingState(
    httpClient: AxiosInstance,
    token: string,
    cameraId: string,
    state: LightingState,
): Promise<LightingState | null> {
    try {
        const resp = await httpClient.put<unknown>(
            `${CLOUD_API}/v11/video_inputs/${cameraId}/lighting/switch`,
            state,
            {
                headers: {
                    Authorization: `Bearer ${token}`,
                    "Content-Type": "application/json",
                    Accept: "application/json",
                },
                validateStatus: () => true,
            },
        );
        if (resp.status !== 200 && resp.status !== 201 && resp.status !== 204) {
            return null;
        }
        if (typeof resp.data !== "object" || resp.data === null) {
            // Some Bosch endpoints return 204 with no body — the caller's
            // pre-PUT state is the best we have, return that.
            return state;
        }
        return normaliseLightingState(resp.data as Record<string, unknown>);
    } catch {
        return null;
    }
}

/**
 * Normalise an arbitrary record into a LightingState, falling back to the
 * default group on any missing / malformed field. Defensive — the field
 * order in Bosch's responses has shifted between firmwares.
 *
 * @param raw
 */
export function normaliseLightingState(raw: Record<string, unknown>): LightingState {
    return {
        frontLightSettings: normaliseGroup(raw.frontLightSettings),
        topLedLightSettings: normaliseGroup(raw.topLedLightSettings),
        bottomLedLightSettings: normaliseGroup(raw.bottomLedLightSettings),
    };
}

function normaliseGroup(raw: unknown): LedGroupSettings {
    if (typeof raw !== "object" || raw === null) {
        return { ...DEFAULT_GROUP };
    }
    const g = raw as Record<string, unknown>;
    const brightness =
        typeof g.brightness === "number" && Number.isFinite(g.brightness)
            ? clamp(Math.round(g.brightness), 0, 100)
            : 0;
    const color =
        typeof g.color === "string" && /^#?[0-9a-fA-F]{6}$/.test(g.color)
            ? normaliseHex(g.color)
            : null;
    const whiteBalance =
        typeof g.whiteBalance === "number" && Number.isFinite(g.whiteBalance)
            ? clamp(g.whiteBalance, -1.0, 1.0)
            : color === null
              ? -1.0
              : null;
    return { brightness, color, whiteBalance };
}

function normaliseHex(hex: string): string {
    const h = hex.startsWith("#") ? hex.slice(1) : hex;
    return `#${h.toUpperCase()}`;
}

function clamp(v: number, lo: number, hi: number): number {
    return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Build the next PUT body for a wallwasher (top + bottom LED) update.
 *
 * The wallwasher is the user-facing concept that combines both top and
 * bottom LED groups. Applying a color/brightness to "the wallwasher" means
 * applying the same value to both groups; the front spotlight stays
 * untouched.
 *
 * @param current      Cached current lighting state (or DEFAULT_LIGHTING_STATE on first run)
 * @param brightness   New brightness 0..100; pass undefined to keep current
 * @param hexColor     New color "#RRGGBB"; pass undefined to keep current,
 *                     pass null to switch to white-balance mode (warm white)
 */
export function buildWallwasherUpdate(
    current: LightingState,
    brightness: number | undefined,
    hexColor: string | null | undefined,
): LightingState {
    const next: LightingState = {
        frontLightSettings: { ...current.frontLightSettings },
        topLedLightSettings: { ...current.topLedLightSettings },
        bottomLedLightSettings: { ...current.bottomLedLightSettings },
    };

    for (const key of ["topLedLightSettings", "bottomLedLightSettings"] as const) {
        const g = { ...next[key] };
        if (brightness !== undefined) {
            g.brightness = clamp(Math.round(brightness), 0, 100);
        }
        if (hexColor !== undefined) {
            if (hexColor === null) {
                // Switch back to white-balance mode (warm white default)
                g.color = null;
                if (g.whiteBalance === null) {
                    g.whiteBalance = -1.0;
                }
            } else {
                g.color = normaliseHex(hexColor);
                g.whiteBalance = null;
            }
        }
        next[key] = g;
    }
    return next;
}
