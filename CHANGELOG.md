# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]
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

[Unreleased]: https://github.com/mosandlt/ioBroker.bosch-smart-home-camera/compare/v0.0.1...HEAD
[0.0.1]: https://github.com/mosandlt/ioBroker.bosch-smart-home-camera/releases/tag/v0.0.1
