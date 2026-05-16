# Changelog (older releases)

Older entries archived from CHANGELOG.md. Recent releases live in the main CHANGELOG.md and README.md.

## [0.3.3] - 2026-05-13
### Added
- Single OSS Firebase API key for both iOS and Android registration paths — retired APK-extracted keys
- FCM diagnostic logging: new `mode-failed` event surfaces HTTP status + URL + Google error message (replaces silent catch in `_tryStart`)
- Polling fallback like the HA integration: when both modes fail `info.fcm_active="polling"` (not `error`) and `/v11/events` is polled every 30 s — adapter stays usable
- Auto-snapshot per camera at adapter start so `cameras.<id>.online` flips from default `false` to real state immediately

### Fixed
- Startup token refresh via stored `refresh_token` before falling back to PKCE — eliminates `No PKCE verifier stored` crash after long downtime
- Polling-fallback `setInterval` is `unref()`'d so mocha exits cleanly when FCM mock fails

## [0.3.2] - 2026-05-13
### Changed
- Repochecker compliance round 2–3 — see `io-package.json` news for detail
- `.releaseconfig.json` now included in npm tarball (E5018)
- `.commitinfo` explicitly listed in `.gitignore` (E9006)
- All built-in `node:` prefix imports (S5043)
- `.vscode/settings.json` with correct ioBroker schema URLs
- `.github/dependabot.yml` with 7-day cooldown
- eslint v9 migration: `eslint.config.mjs` + `@iobroker/eslint-config`
- `axios-cookiejar-support` pinned to `^6.0.5` for Node 20 CI compatibility
- 310 tests passing, 0 lint errors

## [0.3.1] - 2026-05-13
### Added
- Auto-snapshot fetch after `privacy_enabled=false` or `light_enabled` toggle so dashboards reflect the new state immediately
- `cameras.<id>.online` now reflects snapshot reachability (true on success, false after 3 consecutive failures — guards against transient Gen2 "stream has been aborted" hiccups)
- VIS-2 example dashboard (`docs/vis-2-example/`): canvas height 800→900, `tplBulbOnOff` (vis-1) → `tplJquiBool` (vis-2 native) so toggles render correctly, status bar with `Connection: / FCM:` prefixes

### Changed
- Dependencies bumped: `@iobroker/adapter-core` 3.2.2 → 3.3.2, `@iobroker/testing` 4.1.3 → 5.2.2, `@iobroker/adapter-dev` 1.3.0 → 1.5.0
- `io-package.json`: `js-controller` min version 5.0.19 → 6.0.11, `admin` ≥7.6.17 added to `globalDependencies`, `encryptedNative`/`protectedNative` moved from `/common` to root (schema compliance)
- GitHub Actions workflow split into `check-and-lint` + `adapter-tests` + `deploy` jobs, concurrency cancellation, proper tag patterns
- `admin/jsonConfig.json`: full `xs/sm/md/lg/xl` size attributes on all interactive fields

## [0.3.0] - 2026-05-13
### Added
- FCM push listener (real implementation): `@aracna/fcm@1.0.32` MTalk/MCS replaces v0.2.0 stub
- `fetchAndProcessEvents()` polls `/v11/events` on each FCM wake-up, dedup'd via `_lastSeenEventId`
- Gen2 PERSON upgrade in event normalisation (`eventType=MOVEMENT + eventTags=["PERSON"]` → `"person"`)
- `info.fcm_active` lifecycle: `healthy` / `error` / `disconnected` / `stopped`

### Removed
- Image rotation: removed dead RCP+ 0x0810 WRITE (401 on Gen2 FW 9.40.25); flag now pure client-side

## [0.2.0] - 2026-05-13
### Added
- `handlePrivacyToggle`: opens live session → sends RCP+ 0x0808 WRITE via cloud proxy
- `handleLightToggle`: opens live session → sends RCP+ 0x099f WRITE
- `handleImageRotationToggle`: opens live session → sends RCP+ 0x0810 WRITE
- `handleSnapshotTrigger`: opens live session → fetches JPEG via snap.jpg → writes to adapter file-store → sets `cameras.<id>.snapshot_path`
- `ensureLiveSession()`: cached live-session manager with 30 s TTL + auto-reopen
- `startTlsProxy` wired per camera: `cameras.<id>.stream_url = rtsp://127.0.0.1:PORT/rtsp_tunnel`
- `FcmListener` wired in `onReady`: throws `FcmNotImplementedError` → sets `info.fcm_active = stub`
- New states per camera: `stream_url`, `last_motion_at`, `last_motion_event_type`
- New instance state: `info.fcm_active` (healthy / stub / error / stopped)
- `onUnload` cleanup: stops all TLS proxies, FCM listener, closes live sessions
- 4 new unit tests covering all wired handlers (268 total, +6 from v0.1.0)

### Fixed
- Bosch Keycloak login returned HTTP 400 "Restart login cookie not found" because the redirect chain dropped the `KC_RESTART` cookie. Now uses `tough-cookie` + `axios-cookiejar-support` to persist cookies across the entire redirect chain automatically.
- `terminate() not available` warning in logs: replaced over-cautious `?.` optional-chain guard with a direct `this.terminate()` call — this method is always present in `adapter-core` v3.2+ / `js-controller` ≥ 5.0.19 (as declared in `io-package.json` dependencies).

## [0.1.0] - 2026-05-12
### Added
- main.ts wiring: programmatic OAuth login on adapter startup
- Token refresh loop with setTimeout re-arm pattern
- `info.connection`, `info.access_token`, `info.refresh_token`, `info.token_expires_at`, `info.last_login_ago` states
- Camera state tree: `cameras.<id>.{name,firmware_version,hardware_version,generation,online}`
- `encryptedNative` for password (auto-encrypted by js-controller)
- `@alcalzone/release-script` for automated version bumps + GitHub releases

## [0.0.1] - 2026-05-12
### Added
- Initial skeleton release — namespace reservation on npm
- TypeScript adapter scaffolding (`@iobroker/adapter-core`)
- OAuth2 PKCE primitives (`src/lib/auth.ts`)
- HTTP Digest auth helper (`src/lib/digest.ts`)
- Programmatic Keycloak login (`src/lib/login.ts`)
- Camera discovery API client (`src/lib/cameras.ts`)
- 162 unit tests covering all helpers
- LICENSE MIT
- Compliance with `@iobroker/repochecker` (0 fixable errors/warnings remaining)

[0.3.3]: https://github.com/mosandlt/ioBroker.bosch-smart-home-camera/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/mosandlt/ioBroker.bosch-smart-home-camera/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/mosandlt/ioBroker.bosch-smart-home-camera/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/mosandlt/ioBroker.bosch-smart-home-camera/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/mosandlt/ioBroker.bosch-smart-home-camera/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/mosandlt/ioBroker.bosch-smart-home-camera/compare/v0.0.1...v0.1.0
[0.0.1]: https://github.com/mosandlt/ioBroker.bosch-smart-home-camera/releases/tag/v0.0.1
