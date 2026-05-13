# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.1] - 2026-05-13
### Added
- Auto-snapshot fetch after `privacy_enabled=false` and `light_enabled` toggle so dashboards reflect the new state immediately
- `cameras.<id>.online` now reflects snapshot reachability — true on success, false after 3 consecutive failures
- VIS-2 example dashboard (`docs/vis-2-example/`): canvas height 800→900, `tplBulbOnOff` (vis-1) → `tplJquiBool` (vis-2 native single-button toggle), status bar with `Connection:` / `FCM:` prefix labels
- 11 new tests (310 total)

### Changed
- Dependencies bumped: `@iobroker/adapter-core` 3.2.2 → 3.3.2, `@iobroker/testing` 4.1.3 → 5.2.2, `@iobroker/adapter-dev` 1.3.0 → 1.5.0
- `io-package.json` schema compliance: `js-controller` min version 5.0.19 → 6.0.11, `admin` ≥7.6.17 added to `globalDependencies`, `encryptedNative`/`protectedNative` moved from `/common` to root level
- GitHub Actions workflow split into `check-and-lint` + `adapter-tests` + `deploy` jobs, concurrency cancellation, semver tag patterns
- `admin/jsonConfig.json`: full `xs/sm/md/lg/xl` size attributes on all interactive fields

### Fixed
- VIS-2 dashboard rendered "Unbekannter Widget-Typ tplBulbOnOff" because that template only exists in vis-1; switched to vis-2 native `tplJquiBool`

## [0.3.0] - 2026-05-13
### Added
- FCM push listener (real implementation): `@aracna/fcm@1.0.32` MTalk/MCS protocol replaces v0.2.0 stub
- `FcmListener.start()` wired in `onReady` with full event handling: `push`, `registered`, `error`, `disconnect`
- `fetchAndProcessEvents()`: on each FCM wake-up, fetches `/v11/events?videoInputId=<cam>&limit=5` for all cameras, deduplicates by event ID, updates `cameras.<id>.last_motion_at` + `last_motion_event_type`
- Gen2 PERSON upgrade logic in event normalisation: `eventType=MOVEMENT + eventTags=["PERSON"]` → `"person"` (mirrors HA fcm.py)
- `info.fcm_active` updated to `"healthy"` on register, `"error"` on start failure, `"disconnected"` on MTalk socket close
- `_lastSeenEventId` per-camera dedup map prevents duplicate state writes on concurrent FCM pushes
- 14 new tests (299 total, was 285 at v0.2.0)

### Fixed
- Image rotation: removed dead RCP+ 0x0810 WRITE that returned HTTP 401 on Gen2 FW 9.40.25. Now stores flag in `_imageRotation` in-memory map and acks state immediately. Bosch Cloud API has no rotation endpoint — flag is a pure client-side display hint (confirmed: HA integration same approach).

