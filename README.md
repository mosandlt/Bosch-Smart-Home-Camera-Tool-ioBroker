# ioBroker.bosch-smart-home-camera

ioBroker adapter for Bosch Smart Home Cameras (Eyes Outdoor/Indoor, 360°, Gen2 Eyes Indoor II + Outdoor II) — alpha, but the core feature set is functional end-to-end.

See the [Home Assistant integration](https://github.com/mosandlt/Bosch-Smart-Home-Camera-Tool-HomeAssistant) for the mature reference implementation (v12.0.1, HA Quality Scale Platinum).

## Status

**Alpha (v0.3.1)** — verified live against 4 cameras (Gen1 + Gen2, FW 7.91.56 / 9.40.25) on a real ioBroker instance.

What works:
- Browser-based OAuth2 PKCE login via Bosch SingleKey ID (no programmatic password handling — captcha/MFA happen in the browser)
- Token auto-refresh (~45 min cadence; 4xx → re-login required, 5xx → silent retry)
- Camera discovery (Gen1 + Gen2, `GET /v11/video_inputs`)
- Per-camera state tree: `name`, `firmware_version`, `hardware_version`, `generation`, `online`, `privacy_enabled`, `light_enabled`, `image_rotation_180`, `snapshot_trigger`, `snapshot_path`, `stream_url`, `last_motion_at`, `last_motion_event_type`
- Privacy toggle via Bosch Cloud API `PUT /v11/video_inputs/{id}/privacy`
- Light toggle, Gen-specific:
  - Gen2: `PUT /lighting/switch/front` + `/topdown`
  - Gen1: `PUT /lighting_override` (frontLightOn + wallwasherOn)
- Snapshot trigger writes JPEG into the adapter file-store (`/<namespace>/cameras/<id>/snapshot.jpg`), with automatic retry on the first "stream has been aborted" hiccup that Bosch Gen2 firmware emits after idle
- Per-camera TLS proxy: `stream_url = rtsp://127.0.0.1:<port>/rtsp_tunnel` for use in `iobroker.cameras` or go2rtc
- FCM push listener (`@aracna/fcm@1.0.32` MTalk/MCS) for sub-second motion / audio-alarm / person events. `info.fcm_active` reflects state: `healthy` / `error` / `disconnected` / `stopped`
- Encrypted credential storage (`encryptedNative` — js-controller encrypts the refresh token at rest)
- 310 unit tests passing

## Setup

1. **Install** the adapter and create an instance (the adapter starts in "waiting for login" mode).
2. **Open the adapter log** in ioBroker → Log Inspector and filter by `bosch-smart-home-camera`. Look for the line:
   ```
   Login required. Open this URL in your browser and log in to Bosch:
   https://smarthome.authz.bosch.com/auth/realms/home_auth_provider/protocol/openid-connect/auth?…
   ```
3. **Copy that URL** into a browser, log in to your Bosch SingleKey ID (solve captcha/MFA if prompted).
4. **Bosch redirects** your browser to `https://www.bosch.com/boschcam?code=…&state=…`. The page may show a blank or 404 — that is expected. Copy the full URL from the address bar.
5. **Paste the URL** into the adapter's Admin UI → "Pasted callback URL" → Save.
6. The adapter restarts, exchanges the auth code for tokens, fetches your cameras, and starts the FCM listener. Future restarts skip the browser step as long as the stored refresh token is still valid.

If the refresh token is ever rejected (after a Bosch password change or extended downtime), the adapter logs a new login URL and you repeat steps 2–5.

## Dashboard

A ready-to-import VIS-2 example dashboard is in
[`docs/vis-2-example/`](./docs/vis-2-example/) — all four cameras in a 2×2
grid with snapshot refresh (every 5 s), privacy + light toggles, snapshot
trigger button, and a status bar.

Quick install:

```bash
cp docs/vis-2-example/vis-views.json ~/iobroker-data/files/vis-2.0/main/
iobroker restart vis-2
# Open http://HOST:8082/vis-2/index.html#Cameras
```

See [`docs/vis-2-example/README.md`](./docs/vis-2-example/README.md) for the
walkthrough, including how to swap the camera UUIDs and how to wire go2rtc /
HLS for low-latency live video instead of the default snapshot refresh.

Note on **live streaming in the browser**: no browser supports RTSP natively.
The adapter publishes a per-camera `stream_url`
(`rtsp://127.0.0.1:<port>/rtsp_tunnel`) via a local TLS proxy for use with
ffmpeg / mpv / `iobroker.cameras` / go2rtc. For VIS itself, either use the
snapshot refresh in the example dashboard or bridge via go2rtc → WebRTC/HLS.

## Roadmap

| Version | Scope |
| --- | --- |
| v0.4.0 | Motion zones + privacy masks (read/write via `/v11/video_inputs/{id}/motion`) |
| v0.5.0 | Mini-NVR: pre-roll ring buffer + local segment recording |
| v1.0.0 | VIS widget + feature parity with the HA integration |

Image rotation (v0.3.0) is a client-side display flag — Bosch's Cloud API has no rotation endpoint and RCP+ `0x0810` WRITE returns HTTP 401 on Gen2 FW 9.40.25, mirroring the HA integration's approach.

## Development

```bash
npm install
npm run build        # tsc → build/
npm run watch        # auto-rebuild on save
npm test             # unit tests (310 passing)
npm run lint
```

### Manual deploy to a local ioBroker test instance

```bash
SRC=$(pwd)
DST=$HOME/iobroker-test/node_modules/iobroker.bosch-smart-home-camera
rm -rf "$DST/build" && cp -r "$SRC/build" "$DST/"
cp "$SRC/io-package.json" "$DST/"
cp -r "$SRC/admin" "$DST/"
~/iobroker-test/iob upload bosch-smart-home-camera
~/iobroker-test/iob restart bosch-smart-home-camera.0
```

## Existing adapter landscape

- **[iobroker.bshb](https://github.com/holomekc/ioBroker.bshb)** — SHC Local REST API (thermostats, switches, alarms). Camera on/off only, no stream or snapshot. Active maintainer.
- **[iobroker.cameras](https://github.com/ioBroker/ioBroker.cameras)** — generic HTTP snapshot / RTSP wrapper. Pair this adapter's `stream_url` state with iobroker.cameras to get a Vis tile.
- **[iobroker.onvif](https://github.com/iobroker-community-adapters/ioBroker.onvif)** — generic ONVIF. Not usable for Bosch cameras until Bosch ships a public local ONVIF endpoint (planned summer 2026).

## Release process

This adapter uses [`@alcalzone/release-script`](https://github.com/AlCalzone/release-script) for version bumps.

```bash
npm run release patch    # 0.3.0 → 0.3.1
npm run release minor    # 0.3.0 → 0.4.0
npm run release major    # 0.3.0 → 1.0.0
```

1. Builds + runs the full test suite (must pass)
2. Bumps version in `package.json` + `io-package.json`
3. Auto-generates a news entry from commits since the last release
4. Creates the `vX.Y.Z` tag and pushes — GitHub Actions auto-publishes to npm

## Related repos

- HA Integration: [Bosch-Smart-Home-Camera-Tool-HomeAssistant](https://github.com/mosandlt/Bosch-Smart-Home-Camera-Tool-HomeAssistant) (v12.0.1, Quality Scale Platinum)
- Python CLI: [Bosch-Smart-Home-Camera-Tool-Python](https://github.com/mosandlt/Bosch-Smart-Home-Camera-Tool-Python) (v10.2.1)

## Changelog

<!-- repochecker E6006 expects per-version sections in README.md (not just CHANGELOG.md). -->

### 0.3.1 (2026-05-13)
- Auto-snapshot fetch after `privacy_enabled=false` or `light_enabled` toggle so dashboards reflect the new state immediately
- `cameras.<id>.online` now reflects snapshot reachability (true on success, false after 3 consecutive failures — guards against transient Gen2 "stream has been aborted" hiccups)
- VIS-2 example dashboard (`docs/vis-2-example/`): canvas height 800→900, `tplBulbOnOff` (vis-1) → `tplJquiBool` (vis-2 native) so toggles render correctly, status bar with `Connection: / FCM:` prefixes
- Dependencies bumped: `@iobroker/adapter-core` 3.2.2 → 3.3.2, `@iobroker/testing` 4.1.3 → 5.2.2, `@iobroker/adapter-dev` 1.3.0 → 1.5.0
- `io-package.json`: `js-controller` min version 5.0.19 → 6.0.11, `admin` ≥7.6.17 added to `globalDependencies`, `encryptedNative`/`protectedNative` moved from `/common` to root (schema compliance)
- GitHub Actions workflow split into `check-and-lint` + `adapter-tests` + `deploy` jobs, concurrency cancellation, proper tag patterns
- `admin/jsonConfig.json`: full `xs/sm/md/lg/xl` size attributes on all interactive fields

### 0.3.0 (2026-05-13)
- FCM push listener (real implementation): `@aracna/fcm@1.0.32` MTalk/MCS replaces v0.2.0 stub
- `fetchAndProcessEvents()` polls `/v11/events` on each FCM wake-up, dedup'd via `_lastSeenEventId`
- Gen2 PERSON upgrade in event normalisation (`eventType=MOVEMENT + eventTags=["PERSON"]` → `"person"`)
- `info.fcm_active` lifecycle: `healthy` / `error` / `disconnected` / `stopped`
- Image rotation: removed dead RCP+ 0x0810 WRITE (401 on Gen2 FW 9.40.25); flag now pure client-side
- 299 unit tests passing

### 0.2.0 (2026-05-13)
- `handlePrivacyToggle` / `handleLightToggle` / `handleImageRotationToggle` via Cloud API
- `handleSnapshotTrigger` opens live session → fetches JPEG → writes to adapter file-store
- `ensureLiveSession()` cache with 30 s TTL + auto-reopen
- `startTlsProxy` per camera → `cameras.<id>.stream_url = rtsp://127.0.0.1:PORT/rtsp_tunnel`

### 0.1.0 (2026-05-12)
- First functional release — programmatic OAuth login via Bosch SingleKey ID
- Camera discovery via `/v11/video_inputs`, token auto-refresh loop, `info.*` state tree
- Library code for RCP+ protocol (`rcp.ts`) and snap.jpg fetcher (`snapshot.ts`) included as preview

### 0.0.1 (2026-05-12)
- Initial skeleton — namespace reservation, not yet functional

Full per-release diff: [CHANGELOG.md](./CHANGELOG.md).

## License

MIT License — see [LICENSE](./LICENSE).

Copyright © 2026 mosandlt
