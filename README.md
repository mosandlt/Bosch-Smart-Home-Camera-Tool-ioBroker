# ioBroker.bosch-smart-home-camera

ioBroker adapter for Bosch Smart Home Cameras — early development.

See the [Home Assistant integration](https://github.com/mosandlt/Bosch-Smart-Home-Camera-Tool-HomeAssistant) for the current production-ready implementation.

## Vision

A standalone **ioBroker adapter** for Bosch Smart Home Cameras (Eyes Outdoor/Indoor, 360°, Gen2 Eyes Indoor II + Outdoor II) — feature parity with the existing [Home Assistant Integration](https://github.com/mosandlt/Bosch-Smart-Home-Camera-Tool-HomeAssistant) (v12.0.1, HA Quality Scale Platinum).

Planned features:
- Cloud-API login via OAuth2 (Bosch SingleKey ID)
- Live stream over RTSPS / go2rtc bridge
- FCM Push for sub-second motion / audio-alarm / person events
- Snapshot with HTTP Digest Auth
- Privacy / Light / Image-Rotation switches via RCP+
- Configurable motion zones + privacy masks
- Mini-NVR (pre-roll ring buffer + local segments)

## Status

**Alpha (0.1.0)** — First functional release (2026-05-12). Login and camera discovery work end-to-end.

## What works in v0.1.0

- Programmatic OAuth2 login (Bosch SingleKey ID)
- Token auto-refresh (4xx → force re-login, 5xx → retry without re-login)
- Camera discovery (Gen1 + Gen2, `GET /v11/video_inputs`)
- State tree: `info.*`, `cameras.<id>.{name, firmware_version, hardware_version, generation, online}`
- Encrypted password storage (`encryptedNative` — auto-encrypted by js-controller)
- 205 unit tests passing

## What's still TODO

- v0.2.0 — Writable switches (privacy / light / image-rotation) + snapshot to file
- v0.3.0 — Live stream (RTSPS / go2rtc bridge)
- v0.4.0 — FCM motion events (motion, audio-alarm, person)
- v0.5.0 — Mini-NVR (pre-roll ring buffer + local segments)
- v1.0.0 — VIS widget + full feature parity with HA integration

For related repos: https://github.com/mosandlt

## Development

```bash
# Install dependencies
npm install

# Build TypeScript → build/
npm run build

# Watch mode (auto-rebuild on save)
npm run watch

# Run tests
npm test

# Lint
npm run lint
```

Next implementation steps (in order):
1. `src/lib/rcp.ts` — wire RCP+ switches (privacy / light / image-rotation) into main.ts
2. `src/lib/snapshot.ts` — wire snap.jpg fetcher into main.ts
3. `src/lib/stream.ts` — go2rtc RTSPS source registration
4. `src/lib/fcm.ts` — FCM push for motion/person/audio events

## Triggers for implementation start

Implementation kicked off when AdapterRequests #1022 showed sufficient community demand (>10 upvotes reached). Authentication skeleton is available, full implementation in progress.

## Existing adapter landscape (as of 2026-05-12)

- **[iobroker.bshb](https://github.com/holomekc/ioBroker.bshb)** — SHC Local REST API (thermostats, switches, alarms). Camera only on/off, no stream/snapshot. Maintainer: holomekc, active.
- **[iobroker.cameras](https://github.com/ioBroker/ioBroker.cameras)** — generic HTTP snapshot / RTSP wrapper. v2.1.2 July 2024, TypeScript rewrite announced but not finished.
- **[iobroker.onvif](https://github.com/iobroker-community-adapters/ioBroker.onvif)** — generic ONVIF cameras. Currently not usable for Bosch cameras (no ONVIF endpoint exposed).

## Release process

This adapter uses [`@alcalzone/release-script`](https://github.com/AlCalzone/release-script) for version bumps.

```bash
npm run release patch  # 0.0.1 → 0.0.2
npm run release minor  # 0.0.1 → 0.1.0
npm run release major  # 0.0.1 → 1.0.0
```

The script:
1. Runs `npm run build && npm run test:js` (must pass)
2. Bumps version in `package.json` + `io-package.json`
3. Auto-generates a news entry from commits since last release
4. Asks for manual review
5. Creates git tag `vX.Y.Z` + pushes
6. GitHub Actions auto-publishes to npm on tag push

## Related repos

- HA Integration: [Bosch-Smart-Home-Camera-Tool-HomeAssistant](https://github.com/mosandlt/Bosch-Smart-Home-Camera-Tool-HomeAssistant) (v12.0.1, Quality Scale Platinum)
- Python CLI: [Bosch-Smart-Home-Camera-Tool-Python](https://github.com/mosandlt/Bosch-Smart-Home-Camera-Tool-Python) (v10.2.1)
