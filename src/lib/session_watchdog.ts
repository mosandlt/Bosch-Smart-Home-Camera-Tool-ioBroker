/**
 * RTSP session watchdog for LOCAL 24/7 streaming.
 *
 * Bosch LOCAL sessions have a maxSessionDuration (default 3600 s). After
 * expiry the camera closes the RTSPS stream — 24/7 recorders (BlueIris, etc.)
 * would see a drop every hour without proactive renewal.
 *
 * This watchdog schedules a renewal ~60 s before the session expires so the
 * TLS proxy keeps serving continuously. If LOCAL renewal fails, the stream
 * stops and the user is warned — no cloud-relay fallback, ever.
 *
 * Forum reference: ioBroker forum #84538 (Jaschkopf, BlueIris integration).
 */

import type { LiveSession } from "./live_session";

// ── Types ──────────────────────────────────────────────────────────────────────

/** Logger function compatible with adapter's this.log */
type LogFn = (level: "debug" | "info" | "warn" | "error", msg: string) => void;

/** Options for constructing a SessionWatchdog. */
export interface SessionWatchdogOptions {
    /**
     * Called when the watchdog wants a fresh session.
     * Must throw (or reject) if renewal fails — the watchdog will then
     * call onError and stop itself (no retry, no cloud fallback).
     */
    openSession: () => Promise<LiveSession>;
    /**
     * Called with the renewed session so the caller can swap the TLS proxy
     * target and update state objects.
     */
    onRenew: (newSession: LiveSession) => Promise<void>;
    /**
     * Called when openSession() throws. The watchdog has already stopped
     * itself when this is called — caller should clean up the stream.
     */
    onError: (err: Error) => void;
    /** Logger function — pass adapter's this.log */
    log: LogFn;
    /**
     * How many milliseconds before session expiry to trigger renewal.
     * Default: 60_000 ms (60 s).
     */
    renewLeadMs?: number;
}

// ── SessionWatchdog ────────────────────────────────────────────────────────────

/**
 * Schedules automatic renewal of a Bosch LOCAL live session before it expires.
 *
 * Usage:
 *   const watchdog = new SessionWatchdog({ openSession, onRenew, onError, log });
 *   watchdog.start(initialSession);
 *   // ... later on cleanup:
 *   watchdog.stop();
 */
export class SessionWatchdog {
    private readonly _openSession: () => Promise<LiveSession>;
    private readonly _onRenew: (newSession: LiveSession) => Promise<void>;
    private readonly _onError: (err: Error) => void;
    private readonly _log: LogFn;
    private readonly _renewLeadMs: number;

    private _session: LiveSession | null = null;
    private _timer: ReturnType<typeof setTimeout> | null = null;
    private _running = false;

    constructor(opts: SessionWatchdogOptions) {
        this._openSession = opts.openSession;
        this._onRenew = opts.onRenew;
        this._onError = opts.onError;
        this._log = opts.log;
        this._renewLeadMs = opts.renewLeadMs ?? 60_000;
    }

    /**
     * Start the watchdog with the given initial session.
     * Idempotent: calling start() while already running replaces the tracked session
     * and re-arms the timer.
     *
     * @param initialSession  The just-opened LiveSession to watch
     */
    public start(initialSession: LiveSession): void {
        this._session = initialSession;
        this._running = true;
        this._arm(initialSession);
    }

    /**
     * Stop the watchdog. Clears the pending timer. Idempotent.
     */
    public stop(): void {
        this._running = false;
        if (this._timer !== null) {
            clearTimeout(this._timer);
            this._timer = null;
        }
        this._session = null;
    }

    /**
     * Whether the watchdog is currently running and tracking a session.
     */
    public isRunning(): boolean {
        return this._running;
    }

    // ── Private helpers ────────────────────────────────────────────────────────

    /**
     * Schedule the next renewal based on the session's expiry time.
     *
     * expiresAt = session.openedAt + session.maxSessionDuration * 1000
     * timerDelay = expiresAt - now - renewLeadMs
     * Minimum delay: 1 ms (fire immediately if already past the lead time).
     */
    private _arm(session: LiveSession): void {
        if (!this._running) {
            return;
        }

        const durationMs =
            session.maxSessionDuration > 0 ? session.maxSessionDuration * 1_000 : 3_600_000; // 3600 s fallback

        const expiresAt = session.openedAt + durationMs;
        const delay = Math.max(1, expiresAt - Date.now() - this._renewLeadMs);

        this._log(
            "debug",
            `SessionWatchdog: arming renewal for camera ${session.cameraId.slice(0, 8)} ` +
                `in ${Math.round(delay / 1000)} s ` +
                `(session expires in ~${Math.round(durationMs / 1000)} s)`,
        );

        const timer = setTimeout(() => {
            this._timer = null;
            void this._renew();
        }, delay);

        // .unref() so the timer does not prevent Node / mocha from exiting when
        // all tests complete — production: ioBroker keeps the loop alive anyway.
        timer.unref();
        this._timer = timer;
    }

    /** Perform the renewal: open a new session, invoke onRenew, re-arm. */
    private async _renew(): Promise<void> {
        if (!this._running) {
            return;
        }

        const camPrefix = this._session?.cameraId.slice(0, 8) ?? "unknown";
        this._log("info", `SessionWatchdog: renewing LOCAL session for camera ${camPrefix}`);

        let newSession: LiveSession;
        try {
            newSession = await this._openSession();
        } catch (err: unknown) {
            const error = err instanceof Error ? err : new Error(String(err));
            this._log(
                "warn",
                `SessionWatchdog: LOCAL renewal failed for camera ${camPrefix}: ${error.message}`,
            );
            // Stop self before calling onError so callbacks can't race
            this.stop();
            this._onError(error);
            return;
        }

        this._session = newSession;
        try {
            await this._onRenew(newSession);
        } catch (err: unknown) {
            const error = err instanceof Error ? err : new Error(String(err));
            this._log(
                "warn",
                `SessionWatchdog: onRenew callback failed for camera ${camPrefix}: ${error.message}`,
            );
            this.stop();
            this._onError(error);
            return;
        }

        // Re-arm for the next expiry
        this._arm(newSession);
    }
}
