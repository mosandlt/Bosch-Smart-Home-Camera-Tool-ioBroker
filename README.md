# ioBroker.bosch-smart-home-camera

ioBroker adapter for Bosch Smart Home Cameras (Eyes Outdoor/Indoor, 360°, Gen2 Eyes Indoor II + Outdoor II) — beta. The full core feature set is functional end-to-end and verified live against real hardware.

See the [Home Assistant integration](https://github.com/mosandlt/Bosch-Smart-Home-Camera-Tool-HomeAssistant) for the mature reference implementation (v12.0.1, HA Quality Scale Platinum).

## Changelog

### v0.5.2 (beta)
Per-camera livestream switch — default OFF.

- **`cameras.<id>.livestream_enabled`** (new, boolean, writable, default `false`): explicit on/off switch for the continuous RTSP livestream. Previous behaviour opened a 24/7 Bosch LOCAL session + TLS proxy + RTSP watchdog on every adapter start — one open session per camera, consuming the daily LOCAL session quota even when nobody was watching the stream. Streaming is now opt-in:
  - **Write `true`** → adapter calls `PUT /v11/video_inputs/{id}/connection`, spawns the TLS proxy on the sticky port, arms the RTSP watchdog (renews ~60 s before `maxSessionDuration` so external recorders see no drop), and populates `cameras.<id>.stream_url` with the digest-credentials URL.
  - **Write `false`** → watchdog cancelled, TLS proxy stopped, Bosch session closed via `DELETE /v11/video_inputs/{id}/connection`, `stream_url` cleared.
- **Snapshots remain unaffected**: every `snapshot_trigger` (and the one-per-camera startup snapshot that probes the `online` state) still opens a session, fetches the JPEG, and then — when `livestream_enabled` is `false` — closes the session right after so no proxy or watchdog stays running.
- **BlueIris recipe (forum #84538 post 14)**: VLC accepts `rtsp://user:pass@host/...` directly, BlueIris does not. To consume the stream in BlueIris, paste just `rtsp://<host>:<port>/rtsp_tunnel?…` into the address field (strip the `user:pass@` part), enter the Digest username and password in BlueIris's separate **Username / Password** fields, and set **RTSP Authentication = Digest**. Error code `8000007a (CheckPort/User/Password)` typically means BlueIris failed to apply the in-URL credentials — entering them in the dedicated fields resolves it.

### v0.5.1 (beta)
Adds Gen2 siren + RGB wallwasher colour, plus the v0.5.0 forum-driven fixes:

- **Siren** (Gen2 only): new `cameras.<id>.siren_active` boolean DP. Write `true` to trigger the integrated 75 dB siren (panic alarm), `false` to silence. Backed by `PUT /v11/video_inputs/{id}/panic_alarm` with `{status: "ON"|"OFF"}` — the same endpoint the official Bosch app uses.
- **RGB wallwasher** (Gen2 outdoor with `featureSupport.light=true`, i.e. Eyes Außenkamera II): two new DPs — `cameras.<id>.wallwasher_color` (HEX `#RRGGBB`, empty string = warm white mode) and `cameras.<id>.wallwasher_brightness` (0…100). Drives both top and bottom LED groups in unison via `PUT /v11/video_inputs/{id}/lighting/switch`. The front spotlight stays untouched (controlled by `front_light_enabled` as before).
- Privacy state now syncs back from the Bosch app: every 30 s the adapter refetches `/v11/video_inputs` and mirrors `privacyMode` into `cameras.<id>.privacy_enabled`. Previously, setting privacy via the app left the ioBroker DP stale (forum #84538).
- `stream_url` now embeds Digest credentials and Bosch query params (`rtsp://<user>:<password>@host:port/rtsp_tunnel?inst=1&enableaudio=1&fmtp=1&maxSessionDuration=…`) so external recorders (BlueIris, Frigate, `iobroker.cameras`) no longer get "401 Unauthorized" on connect.
- TLS-proxy port is sticky across session renewals and adapter restarts (persisted in `cameras.<id>._proxy_port`). External recorders no longer need URL reconfiguration after each hourly Bosch session refresh.
- New admin tab "RTSP / Stream": tickbox to bind the proxy to `0.0.0.0` (instead of `127.0.0.1`) plus an external-host field so the published URL uses the ioBroker host's LAN IP — required when BlueIris / Frigate runs on a separate machine.
- Motion trigger DP description clarified: `motion_trigger` is for ioBroker-side automations only; it updates `last_motion_at` but does **not** make the Bosch app create a recording.

### v0.4.0
- Light-datapoint split: `front_light_enabled` + `wallwasher_enabled` can now be controlled independently (e.g. a dusk sensor drives the wallwasher only, without touching the front spotlight)
- Synthetic motion trigger: write `true` to `cameras.<id>.motion_trigger` (select event type via `motion_trigger_event_type`) to inject a motion/person/audio_alarm event from an external sensor (e.g. Philips Hue in the driveway) so automations fire immediately without waiting for the Bosch FCM push
- RTSP session watchdog: LOCAL Bosch sessions renew automatically ~60 s before `maxSessionDuration` expires — BlueIris and similar 24/7 recorders no longer see an hourly stream drop
- Cloud-relay media paths fully removed: adapter enforces LOCAL-only for all media (RTSP + snapshots); if the camera is unreachable on the LAN a clear error is logged — no silent fallback to `proxy-NN.live.cbs.boschsecurity.com:42090`

### v0.3.3
FCM resilience + token refresh on startup. Single Bosch OSS Firebase API key, per-mode failure surfacing, auto-snapshot at start, polling fallback.

## Status

**Beta (v0.5.1)** — verified live against 4 cameras (Gen1 + Gen2, FW 7.91.56 / 9.40.25) on a real ioBroker instance. Cloud API contracts confirmed against the iOS app via mitmproxy.

What works:
- Browser-based OAuth2 PKCE login via Bosch SingleKey ID (no programmatic password handling — captcha/MFA happen in the browser)
- Token auto-refresh (~45 min cadence; 4xx → re-login required, 5xx → silent retry). Stored `refresh_token` also used at startup to mint a fresh `access_token` silently — no PKCE re-login required after restart, even if the adapter was stopped longer than the 1 h access-token lifetime.
- Camera discovery (Gen1 + Gen2, `GET /v11/video_inputs`)
- Per-camera state tree: `name`, `firmware_version`, `hardware_version`, `generation`, `online`, `privacy_enabled`, `light_enabled`, `front_light_enabled`, `wallwasher_enabled`, `image_rotation_180`, `snapshot_trigger`, `motion_trigger`, `motion_trigger_event_type`, `snapshot_path`, `stream_url`, `last_motion_at`, `last_motion_event_type`
- Privacy toggle via Bosch Cloud API `PUT /v11/video_inputs/{id}/privacy`
- Light toggle, Gen-specific and now split into independent datapoints:
  - Gen2: `PUT /lighting/switch/front` + `/topdown`
  - Gen1: `PUT /lighting_override` (frontLightOn + wallwasherOn)
  - `front_light_enabled` and `wallwasher_enabled` can be toggled independently; `light_enabled` remains as a legacy combined switch
- Synthetic motion trigger (`motion_trigger` write-only button + `motion_trigger_event_type` selector) for external sensor integration without waiting for Bosch FCM push
- Snapshot trigger writes JPEG into the adapter file-store (`/<namespace>/cameras/<id>/snapshot.jpg`), with automatic retry on the first "stream has been aborted" hiccup that Bosch Gen2 firmware emits after idle. One startup snapshot per camera flips `cameras.<id>.online` from the default `false` to the real state immediately.
- Per-camera TLS proxy: `stream_url = rtsp://127.0.0.1:<port>/rtsp_tunnel` for use in `iobroker.cameras` or go2rtc. LOCAL-only by design — no cloud relay.
- RTSP session watchdog: LOCAL sessions renew automatically ~60 s before `maxSessionDuration` expires — 24/7 recording works without hourly stream drops
- FCM push listener (`@aracna/fcm@1.0.32` MTalk/MCS) for sub-second motion / audio-alarm / person events. `info.fcm_active` reflects state: `healthy` / `polling` / `error` / `disconnected` / `stopped`. When push registration fails the adapter falls back to `/v11/events` polling every 30 s (`info.fcm_active=polling`) — events still arrive, just with higher latency.
- Encrypted credential storage (`encryptedNative` — js-controller encrypts the refresh token at rest)
- ~320 unit tests passing

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

## Blockly examples

Import-ready Blockly scripts for the most common automations live in
[`docs/blockly-examples/`](./docs/blockly-examples/): master-wallwasher
switch, dusk-driven auto-wallwasher via Astro, and a Philips-Hue-PIR →
synthetic Bosch motion bridge. Open javascript adapter → Scripts → new
Blockly → click the XML icon → paste. Replace `<CAM_UUID>` placeholders
with your actual camera IDs from the Objects tab. See the folder's
[README](./docs/blockly-examples/README.md) for details.

Note on **live streaming in the browser**: no browser supports RTSP natively.
The adapter publishes a per-camera `stream_url`
(`rtsp://<user>:<password>@127.0.0.1:<port>/rtsp_tunnel?…`) via a local TLS
proxy for use with ffmpeg / mpv / `iobroker.cameras` / go2rtc. For VIS
itself, either use the snapshot refresh in the example dashboard or bridge
via go2rtc → WebRTC/HLS.

### External recorders (BlueIris, Frigate)

By default the proxy listens on `127.0.0.1` — reachable from the ioBroker
host itself but not from another machine. To use a recorder on a separate
host:

1. Admin UI → "RTSP / Stream" tab → tick **Expose RTSP proxy to LAN**.
2. Set **External hostname / LAN IP** to the ioBroker host's LAN IP, e.g.
   `192.168.1.50`.
3. Save → adapter restarts → `cameras.<id>.stream_url` becomes
   `rtsp://<user>:<password>@192.168.1.50:<sticky-port>/rtsp_tunnel?…`.
4. Copy that URL into BlueIris / Frigate / your recorder.

The port is sticky across adapter restarts and Bosch session renewals
(persisted in `cameras.<id>._proxy_port`) — set the URL in your recorder
once and it keeps working.

## Roadmap

| Version | Scope |
| --- | --- |
| v0.6.0 | Motion zones + privacy masks (read via `/v11/video_inputs/{id}/motion`) |
| v0.7.0 | Mini-NVR: pre-roll ring buffer + local segment recording |
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
- **[iobroker.onvif](https://github.com/iobroker-community-adapters/ioBroker.onvif)** — generic ONVIF. Bosch cameras don't currently expose a local ONVIF endpoint, so this adapter is the only path for Bosch hardware.

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

<!-- @alcalzone/release-script inserts new entries under the WIP placeholder. -->
<!-- Older releases archived in CHANGELOG_OLD.md. -->

### **WORK IN PROGRESS**

### 0.3.3 (2026-05-13)
- Single OSS Firebase API key for both iOS and Android registration paths — retired APK-extracted keys
- FCM diagnostic logging: new `mode-failed` event surfaces HTTP status + URL + Google error message (replaces silent catch in `_tryStart`)
- Polling fallback like the HA integration: when both modes fail `info.fcm_active="polling"` (not `error`) and `/v11/events` is polled every 30 s — adapter stays usable
- Auto-snapshot per camera at adapter start so `cameras.<id>.online` flips from default `false` to real state immediately
- Startup token refresh via stored `refresh_token` before falling back to PKCE — eliminates `No PKCE verifier stored` crash after long downtime
- Polling-fallback `setInterval` is `unref()`'d so mocha exits cleanly when FCM mock fails

### 0.3.2 (2026-05-13)
- Repochecker compliance round 2–3 — see `io-package.json` news for detail
- `.releaseconfig.json` now included in npm tarball (E5018)
- `.commitinfo` explicitly listed in `.gitignore` (E9006)
- All built-in `node:` prefix imports (S5043)
- `.vscode/settings.json` with correct ioBroker schema URLs
- `.github/dependabot.yml` with 7-day cooldown
- eslint v9 migration: `eslint.config.mjs` + `@iobroker/eslint-config`
- `axios-cookiejar-support` pinned to `^6.0.5` for Node 20 CI compatibility
- 310 tests passing, 0 lint errors


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
