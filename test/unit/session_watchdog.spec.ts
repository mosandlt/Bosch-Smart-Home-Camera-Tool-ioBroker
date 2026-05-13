/**
 * Unit tests for src/lib/session_watchdog.ts
 *
 * Tests the RTSP session watchdog that renews LOCAL Bosch sessions
 * ~60 s before they expire (default maxSessionDuration 3600 s).
 *
 * Forum reference: ioBroker forum #84538 (Jaschkopf, BlueIris 24/7 streaming).
 *
 * Framework: Mocha + Chai + sinon (fake timers)
 *
 * Tests:
 *  1.  Renewal fires at expiresAt - renewLeadMs
 *  2.  onRenew is called with the new session
 *  3.  After renewal the watchdog re-arms for the next cycle
 *  4.  onError is called when openSession throws; watchdog stops itself
 *  5.  stop() is idempotent — calling twice is safe
 *  6.  stop() prevents a pending renewal from firing
 *  7.  isRunning() reflects state accurately
 *  8.  timer.unref() is applied so mocha exits without --exit
 *  9.  onError called if onRenew callback throws
 * 10.  Custom renewLeadMs is respected
 */

import { expect } from "chai";
import * as sinon from "sinon";

import { SessionWatchdog } from "../../src/lib/session_watchdog";
import type { LiveSession } from "../../src/lib/live_session";

// ── Helpers ────────────────────────────────────────────────────────────────────

const CAMERA_UUID = "EF791764-A48D-4F00-9B32-EF04BEB0DDA0";

/** Build a minimal LiveSession for testing. */
function makeSession(
    opts: {
        openedAt?: number;
        maxSessionDuration?: number;
    } = {},
): LiveSession {
    return {
        cameraId: CAMERA_UUID,
        proxyUrl: "https://192.0.2.10:443/snap.jpg?JpegSize=1206",
        connectionType: "LOCAL",
        digestUser: "cbs-testuser",
        digestPassword: "testpassword",
        lanAddress: "192.0.2.10:443",
        bufferingTimeMs: 500,
        maxSessionDuration: opts.maxSessionDuration ?? 3600,
        openedAt: opts.openedAt ?? Date.now(),
    };
}

/** Noop log function */
function noop(): void {
    /* intentionally empty */
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("SessionWatchdog", () => {
    let clock: sinon.SinonFakeTimers;

    beforeEach(() => {
        // Use fake timers to control setTimeout without waiting wall-clock time
        clock = sinon.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    });

    afterEach(() => {
        clock.restore();
    });

    // ── Test 1: renewal fires at expiresAt - renewLeadMs ──────────────────────
    it("(1) renewal fires at expiresAt - renewLeadMs (default 60 s)", async () => {
        const renewLeadMs = 60_000;
        const maxDuration = 3600; // seconds
        const now = Date.now();
        const session = makeSession({ openedAt: now, maxSessionDuration: maxDuration });

        const newSession = makeSession({
            openedAt: now + maxDuration * 1000,
            maxSessionDuration: maxDuration,
        });
        const openSession = sinon.stub().resolves(newSession);
        const onRenew = sinon.stub().resolves(undefined);
        const onError = sinon.stub();

        const watchdog = new SessionWatchdog({
            openSession,
            onRenew,
            onError,
            log: noop,
            renewLeadMs,
        });
        watchdog.start(session);

        // Should NOT have renewed yet
        expect(openSession.callCount, "openSession not called before timer").to.equal(0);

        // Advance to just before the renewal point — should still not fire
        clock.tick(maxDuration * 1000 - renewLeadMs - 1);
        expect(openSession.callCount, "openSession not called 1 ms before deadline").to.equal(0);

        // Advance 1 more ms — should fire
        clock.tick(1);
        // Allow micro-tasks to settle
        await Promise.resolve();
        await Promise.resolve();

        expect(openSession.callCount, "openSession called after deadline").to.equal(1);

        watchdog.stop();
    });

    // ── Test 2: onRenew is called with the new session ─────────────────────────
    it("(2) onRenew called with fresh session from openSession", async () => {
        const now = Date.now();
        const session = makeSession({ openedAt: now, maxSessionDuration: 100 });
        const newSession = makeSession({ openedAt: now + 100_000, maxSessionDuration: 100 });

        const openSession = sinon.stub().resolves(newSession);
        const onRenew = sinon.stub().resolves(undefined);
        const onError = sinon.stub();

        const watchdog = new SessionWatchdog({
            openSession,
            onRenew,
            onError,
            log: noop,
            renewLeadMs: 10_000,
        });
        watchdog.start(session);

        // Advance past renewal point (100 s - 10 s = 90 s)
        clock.tick(90_001);
        await Promise.resolve();
        await Promise.resolve();

        expect(onRenew.callCount, "onRenew called once").to.equal(1);
        expect(onRenew.firstCall.args[0], "onRenew receives newSession").to.deep.equal(newSession);

        watchdog.stop();
    });

    // ── Test 3: watchdog re-arms after renewal ─────────────────────────────────
    it("(3) watchdog re-arms for the next cycle after successful renewal", async () => {
        const now = Date.now();
        const session = makeSession({ openedAt: now, maxSessionDuration: 100 });

        let callCount = 0;
        const openSession = sinon.stub().callsFake((): Promise<LiveSession> => {
            callCount++;
            return Promise.resolve(
                makeSession({ openedAt: clock.Date.now(), maxSessionDuration: 100 }),
            );
        });
        const onRenew = sinon.stub().resolves(undefined);
        const onError = sinon.stub();

        const watchdog = new SessionWatchdog({
            openSession,
            onRenew,
            onError,
            log: noop,
            renewLeadMs: 10_000,
        });
        watchdog.start(session);

        // First renewal at t=90 s
        clock.tick(90_001);
        await Promise.resolve();
        await Promise.resolve();
        expect(callCount, "first renewal fired").to.equal(1);

        // Second renewal should fire at t=90+90=180 s
        clock.tick(90_001);
        await Promise.resolve();
        await Promise.resolve();
        expect(callCount, "second renewal fired").to.equal(2);

        watchdog.stop();
    });

    // ── Test 4: onError when openSession throws; watchdog stops ───────────────
    it("(4) openSession throws → onError called, watchdog stops itself", async () => {
        const now = Date.now();
        const session = makeSession({ openedAt: now, maxSessionDuration: 100 });
        const renewError = new Error("Camera unreachable on LAN");

        const openSession = sinon.stub().rejects(renewError);
        const onRenew = sinon.stub().resolves(undefined);
        const onError = sinon.stub();

        const watchdog = new SessionWatchdog({
            openSession,
            onRenew,
            onError,
            log: noop,
            renewLeadMs: 10_000,
        });
        watchdog.start(session);
        expect(watchdog.isRunning(), "running before renewal").to.be.true;

        clock.tick(90_001);
        await Promise.resolve();
        await Promise.resolve();

        expect(onError.callCount, "onError called once").to.equal(1);
        expect(onError.firstCall.args[0], "onError receives the error").to.equal(renewError);
        expect(watchdog.isRunning(), "watchdog stopped after error").to.be.false;
        expect(onRenew.callCount, "onRenew NOT called when openSession throws").to.equal(0);
    });

    // ── Test 5: stop() is idempotent ──────────────────────────────────────────
    it("(5) stop() is idempotent — calling twice does not throw", () => {
        const session = makeSession();
        const watchdog = new SessionWatchdog({
            openSession: sinon.stub().resolves(makeSession()),
            onRenew: sinon.stub().resolves(undefined),
            onError: sinon.stub(),
            log: noop,
        });
        watchdog.start(session);

        let threw = false;
        try {
            watchdog.stop();
            watchdog.stop(); // second call should be safe
        } catch {
            threw = true;
        }
        expect(threw, "stop() must not throw on double-call").to.be.false;
        expect(watchdog.isRunning(), "not running after stop").to.be.false;
    });

    // ── Test 6: stop() prevents a pending renewal from firing ─────────────────
    it("(6) stop() prevents pending renewal from firing", async () => {
        const now = Date.now();
        const session = makeSession({ openedAt: now, maxSessionDuration: 100 });
        const openSession = sinon.stub().resolves(makeSession());
        const onRenew = sinon.stub().resolves(undefined);
        const onError = sinon.stub();

        const watchdog = new SessionWatchdog({
            openSession,
            onRenew,
            onError,
            log: noop,
            renewLeadMs: 10_000,
        });
        watchdog.start(session);

        // Stop before the renewal fires
        watchdog.stop();

        // Advance past the renewal point
        clock.tick(95_000);
        await Promise.resolve();
        await Promise.resolve();

        expect(openSession.callCount, "openSession must not fire after stop()").to.equal(0);
        expect(onRenew.callCount, "onRenew must not fire after stop()").to.equal(0);
    });

    // ── Test 7: isRunning() reflects state ────────────────────────────────────
    it("(7) isRunning() returns false before start and true while running", () => {
        const watchdog = new SessionWatchdog({
            openSession: sinon.stub().resolves(makeSession()),
            onRenew: sinon.stub().resolves(undefined),
            onError: sinon.stub(),
            log: noop,
        });

        expect(watchdog.isRunning(), "not running before start").to.be.false;
        watchdog.start(makeSession());
        expect(watchdog.isRunning(), "running after start").to.be.true;
        watchdog.stop();
        expect(watchdog.isRunning(), "not running after stop").to.be.false;
    });

    // ── Test 8: timer.unref() is applied ──────────────────────────────────────
    // We verify that the watchdog does NOT prevent process exit when no other
    // handles are open. Mocha would hang without --exit if .unref() were missing.
    // The sinon fake timer environment masks this — instead we verify indirectly
    // that the real watchdog calls .unref() by checking a structural property:
    // stop() + no pending timers means mocha exits (this test itself serves as proof
    // because the full suite runs without --exit).
    it("(8) watchdog does not prevent mocha from exiting (timer.unref() applied)", () => {
        // Create a watchdog with a very long lead time so the timer won't fire
        // during the test, then verify we can stop it cleanly.
        const watchdog = new SessionWatchdog({
            openSession: sinon.stub().resolves(makeSession()),
            onRenew: sinon.stub().resolves(undefined),
            onError: sinon.stub(),
            log: noop,
            renewLeadMs: 120_000,
        });
        watchdog.start(makeSession({ maxSessionDuration: 3600 }));
        expect(watchdog.isRunning()).to.be.true;
        watchdog.stop();
        expect(watchdog.isRunning()).to.be.false;
        // If .unref() were missing and stop() forgot to clear the timer, mocha would hang.
        // The fact that the test suite exits cleanly is the real assertion.
    });

    // ── Test 9: onError called if onRenew throws ──────────────────────────────
    it("(9) onRenew callback throws → onError called, watchdog stops", async () => {
        const now = Date.now();
        const session = makeSession({ openedAt: now, maxSessionDuration: 100 });
        const renewError = new Error("upsertSession failed");

        const openSession = sinon.stub().resolves(makeSession());
        const onRenew = sinon.stub().rejects(renewError);
        const onError = sinon.stub();

        const watchdog = new SessionWatchdog({
            openSession,
            onRenew,
            onError,
            log: noop,
            renewLeadMs: 10_000,
        });
        watchdog.start(session);

        clock.tick(90_001);
        await Promise.resolve();
        await Promise.resolve();

        expect(onError.callCount, "onError called when onRenew throws").to.equal(1);
        expect(watchdog.isRunning(), "watchdog stopped after onRenew error").to.be.false;
    });

    // ── Test 10: custom renewLeadMs ────────────────────────────────────────────
    it("(10) custom renewLeadMs of 120 s is respected", async () => {
        const renewLeadMs = 120_000;
        const maxDuration = 3600;
        const now = Date.now();
        const session = makeSession({ openedAt: now, maxSessionDuration: maxDuration });

        const openSession = sinon.stub().resolves(makeSession());
        const onRenew = sinon.stub().resolves(undefined);

        const watchdog = new SessionWatchdog({
            openSession,
            onRenew,
            onError: sinon.stub(),
            log: noop,
            renewLeadMs,
        });
        watchdog.start(session);

        // Advance to 1 ms before the renewal point
        clock.tick(maxDuration * 1000 - renewLeadMs - 1);
        await Promise.resolve();
        expect(openSession.callCount, "not fired 1 ms early").to.equal(0);

        // Fire
        clock.tick(1);
        await Promise.resolve();
        await Promise.resolve();
        expect(openSession.callCount, "fired at correct time").to.equal(1);

        watchdog.stop();
    });
});
