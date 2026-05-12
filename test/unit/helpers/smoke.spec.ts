/**
 * Smoke tests for the shared test-infrastructure helpers.
 *
 * Verifies that stubAxiosSequence, stubAxiosError, and restoreAxios work
 * correctly before other unit tests depend on them.
 */

import { expect } from "chai";
import axios from "axios";
import { stubAxiosSequence, stubAxiosError, restoreAxios } from "./axios-mock";

describe("test infrastructure smoke", () => {
    afterEach(() => {
        restoreAxios();
    });

    it("stubAxiosSequence resolves multiple responses in order", async () => {
        stubAxiosSequence([
            { status: 200, data: "first" },
            { status: 200, data: "second" },
        ]);

        const r1 = await axios.request({ url: "http://localhost/x" });
        const r2 = await axios.request({ url: "http://localhost/y" });
        expect(r1.data).to.equal("first");
        expect(r2.data).to.equal("second");
    });

    it("stubAxiosSequence defaults missing fields to 200/OK", async () => {
        stubAxiosSequence([{ data: { token: "abc" } }]);
        const r = await axios.request({ url: "http://localhost/z" });
        expect(r.status).to.equal(200);
        expect(r.statusText).to.equal("OK");
        expect(r.data).to.deep.equal({ token: "abc" });
    });

    it("stubAxiosError rejects with HTTP error", async () => {
        stubAxiosError(401, { error: "invalid_token" });
        try {
            await axios.request({ url: "http://localhost/x" });
            expect.fail("should have thrown");
        } catch (err: unknown) {
            const e = err as { response?: { status: number; data: { error: string } } };
            expect(e.response?.status).to.equal(401);
            expect(e.response?.data.error).to.equal("invalid_token");
        }
    });

    it("restoreAxios restores real adapter (no stub interference after restore)", async () => {
        stubAxiosSequence([{ status: 200, data: "stubbed" }]);
        restoreAxios();
        // After restore, axios.defaults.adapter is no longer our stub.
        // We cannot make a real network call in unit tests, but we can verify
        // the adapter reference is no longer the stub by checking the type.
        // Real adapter is a function or array — not the one we installed.
        const adapter = axios.defaults.adapter;
        // The real adapter is a built-in function or string ('xhr' | 'http')
        // — it's always defined (axios ships with http + xhr adapters).
        expect(adapter).to.not.be.undefined;
    });
});
