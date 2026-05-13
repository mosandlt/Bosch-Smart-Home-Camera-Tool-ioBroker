# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/mosandlt/ioBroker.bosch-smart-home-camera/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/mosandlt/ioBroker.bosch-smart-home-camera/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/mosandlt/ioBroker.bosch-smart-home-camera/compare/v0.0.1...v0.1.0
[0.0.1]: https://github.com/mosandlt/ioBroker.bosch-smart-home-camera/releases/tag/v0.0.1
