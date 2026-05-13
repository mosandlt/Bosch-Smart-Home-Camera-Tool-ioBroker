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
/**
 * Schedules automatic renewal of a Bosch LOCAL live session before it expires.
 *
 * Usage:
 *   const watchdog = new SessionWatchdog({ openSession, onRenew, onError, log });
 *   watchdog.start(initialSession);
 *   // ... later on cleanup:
 *   watchdog.stop();
 */
export declare class SessionWatchdog {
    private readonly _openSession;
    private readonly _onRenew;
    private readonly _onError;
    private readonly _log;
    private readonly _renewLeadMs;
    private _session;
    private _timer;
    private _running;
    constructor(opts: SessionWatchdogOptions);
    /**
     * Start the watchdog with the given initial session.
     * Idempotent: calling start() while already running replaces the tracked session
     * and re-arms the timer.
     *
     * @param initialSession  The just-opened LiveSession to watch
     */
    start(initialSession: LiveSession): void;
    /**
     * Stop the watchdog. Clears the pending timer. Idempotent.
     */
    stop(): void;
    /**
     * Whether the watchdog is currently running and tracking a session.
     */
    isRunning(): boolean;
    /**
     * Schedule the next renewal based on the session's expiry time.
     *
     * expiresAt = session.openedAt + session.maxSessionDuration * 1000
     * timerDelay = expiresAt - now - renewLeadMs
     * Minimum delay: 1 ms (fire immediately if already past the lead time).
     */
    private _arm;
    /** Perform the renewal: open a new session, invoke onRenew, re-arm. */
    private _renew;
}
export {};
//# sourceMappingURL=session_watchdog.d.ts.map