# Bosch-Smart-Home-Camera-Tool-ioBroker

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

**Pre-Alpha (0.1.0)** — TypeScript skeleton scaffolded 2026-05-12. Auth helpers + adapter entry point exist, no live camera data yet. Login + camera discovery are the next steps.

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
1. `src/lib/auth.ts` — implement `generatePkcePair()`, `buildAuthUrl()`, `extractCode()`, `exchangeCode()`, `refreshAccessToken()`
2. `src/lib/cameras.ts` — `GET /v1/accounts/{id}/cameras` → camera list
3. `src/main.ts` — wire up OAuth2 login + state object creation per camera
4. `src/lib/stream.ts` — go2rtc RTSPS source registration
5. `src/lib/fcm.ts` — FCM push for motion/person/audio events

## Triggers for implementation start

Implementation kicked off when AdapterRequests #1022 showed sufficient community demand (>10 upvotes reached). Authentication skeleton is available, full implementation in progress.

## Existing adapter landscape (as of 2026-05-12)

- **[iobroker.bshb](https://github.com/holomekc/ioBroker.bshb)** — SHC Local REST API (thermostats, switches, alarms). Camera only on/off, no stream/snapshot. Maintainer: holomekc, active.
- **[iobroker.cameras](https://github.com/ioBroker/ioBroker.cameras)** — generic HTTP snapshot / RTSP wrapper. v2.1.2 July 2024, TypeScript rewrite announced but not finished.
- **[iobroker.onvif](https://github.com/iobroker-community-adapters/ioBroker.onvif)** — generic ONVIF cameras. Currently not usable for Bosch cameras (no ONVIF endpoint exposed).

## Related repos

- HA Integration: [Bosch-Smart-Home-Camera-Tool-HomeAssistant](https://github.com/mosandlt/Bosch-Smart-Home-Camera-Tool-HomeAssistant) (v12.0.1, Quality Scale Platinum)
- Python CLI: [Bosch-Smart-Home-Camera-Tool-Python](https://github.com/mosandlt/Bosch-Smart-Home-Camera-Tool-Python) (v10.2.1)
