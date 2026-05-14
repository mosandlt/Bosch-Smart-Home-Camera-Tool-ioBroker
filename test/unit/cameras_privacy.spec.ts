/**
 * Regression tests for /v11/video_inputs privacyMode parsing in src/lib/cameras.ts.
 *
 * Forum source: ioBroker #84538 (Jaschkopf, 2026-05-14, post 10) — privacy
 * set via ioBroker stayed `true` after the Bosch app re-enabled the camera.
 * Root cause: `fetchCameras()` did not extract `privacyMode` from the list
 * endpoint, so periodic state polling had nothing to sync.
 *
 * Locks in that:
 *   - `privacyMode: "ON"`  → BoschCamera.privacyMode === "ON"
 *   - `privacyMode: "OFF"` → BoschCamera.privacyMode === "OFF"
 *   - case-insensitive (Bosch responses observed as both "ON" and "on")
 *   - missing / unrecognised values → undefined (caller can skip sync)
 */

import { expect } from "chai";
import axios from "axios";

import { fetchCameras } from "../../src/lib/cameras";
import { stubAxiosSequence, restoreAxios } from "./helpers/axios-mock";

const CAM_ID = "EF791764-A48D-4F00-9B32-EF04BEB0DDA0";

describe("fetchCameras() privacyMode parsing (forum #84538)", () => {
    afterEach(() => {
        restoreAxios();
    });

    it('privacyMode "ON" is parsed to "ON"', async () => {
        stubAxiosSequence([
            {
                status: 200,
                data: [
                    {
                        id: CAM_ID,
                        title: "Terrasse",
                        hardwareVersion: "HOME_Eyes_Outdoor",
                        firmwareVersion: "9.40.25",
                        privacyMode: "ON",
                    },
                ],
            },
        ]);
        const cams = await fetchCameras(axios.create(), "token");
        expect(cams[0].privacyMode).to.equal("ON");
    });

    it('privacyMode "OFF" is parsed to "OFF"', async () => {
        stubAxiosSequence([
            {
                status: 200,
                data: [
                    {
                        id: CAM_ID,
                        title: "Terrasse",
                        hardwareVersion: "HOME_Eyes_Outdoor",
                        firmwareVersion: "9.40.25",
                        privacyMode: "OFF",
                    },
                ],
            },
        ]);
        const cams = await fetchCameras(axios.create(), "token");
        expect(cams[0].privacyMode).to.equal("OFF");
    });

    it("lowercase 'on' is normalised to ON", async () => {
        stubAxiosSequence([
            {
                status: 200,
                data: [
                    {
                        id: CAM_ID,
                        title: "Terrasse",
                        hardwareVersion: "HOME_Eyes_Outdoor",
                        firmwareVersion: "9.40.25",
                        privacyMode: "on",
                    },
                ],
            },
        ]);
        const cams = await fetchCameras(axios.create(), "token");
        expect(cams[0].privacyMode).to.equal("ON");
    });

    it("missing privacyMode → undefined (caller skips sync)", async () => {
        stubAxiosSequence([
            {
                status: 200,
                data: [
                    {
                        id: CAM_ID,
                        title: "Terrasse",
                        hardwareVersion: "HOME_Eyes_Outdoor",
                        firmwareVersion: "9.40.25",
                    },
                ],
            },
        ]);
        const cams = await fetchCameras(axios.create(), "token");
        expect(cams[0].privacyMode).to.be.undefined;
    });

    it("unrecognised value → undefined (defensive — keep DP untouched)", async () => {
        stubAxiosSequence([
            {
                status: 200,
                data: [
                    {
                        id: CAM_ID,
                        title: "Terrasse",
                        hardwareVersion: "HOME_Eyes_Outdoor",
                        firmwareVersion: "9.40.25",
                        privacyMode: "MAYBE",
                    },
                ],
            },
        ]);
        const cams = await fetchCameras(axios.create(), "token");
        expect(cams[0].privacyMode).to.be.undefined;
    });
});
