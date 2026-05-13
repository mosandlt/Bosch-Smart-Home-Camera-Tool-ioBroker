# VIS-2 example dashboard for `iobroker.bosch-smart-home-camera`

A ready-to-import VIS-2 project with one dashboard view ("Cameras") that
displays all four cameras in a 2×2 grid. Each cell shows:

- Live snapshot (refreshes every 5 seconds from the adapter file-store)
- Camera name overlay (top-left)
- Privacy toggle (red when on)
- Light toggle (yellow when on)
- Snapshot trigger button (green when pressed)

Plus a status bar at the top showing `info.connection` and `info.fcm_active`.

## Why MJPEG snapshots, not live RTSP?

Browsers do not implement the RTSP protocol — neither Chrome, Safari, Firefox
nor Edge can render `rtsp://` URLs directly. The adapter exposes a per-camera
`stream_url` (e.g. `rtsp://127.0.0.1:54321/rtsp_tunnel`) for use in players
like ffmpeg / mpv / go2rtc / `iobroker.cameras`, but VIS itself can only show
either **periodic JPEG snapshots** or an `<iframe>` pointing at an HLS gateway.

The example here uses the snapshot approach. Trade-offs:

| Approach | Latency | Bandwidth | Setup |
| --- | --- | --- | --- |
| Snapshot refresh (this example) | 5 s | low | zero — works out of the box |
| go2rtc HLS bridge | 2–6 s | medium | go2rtc add-on + WebRTC config |
| iobroker.cameras adapter | 1–3 s | medium | install + wire `stream_url` |

If you want true low-latency live video in VIS, see the
[Live stream via go2rtc](#live-stream-via-go2rtc) section below.

## Prerequisites

- ioBroker host with `vis-2` and `web` adapter instances running (default
  port `8082`)
- `iobroker.bosch-smart-home-camera` instance configured and producing
  snapshots into `cameras.<id>.snapshot_path` (verify by triggering one
  manually first)

## Install

### Option A — import via `iobroker file write` (fastest)

```bash
# Run on the ioBroker host
iobroker file write vis-views.json /vis-2.0/main/vis-views.json
iobroker restart vis-2
```

Then open `http://<HOST>:8082/vis-2/index.html#Cameras` (replace `<HOST>` with your
ioBroker host, e.g. `localhost` or `192.168.x.y`).

> **Do not just `cp` the file into `~/iobroker-data/files/vis-2.0/main/`** — vis-2
> indexes project files via `_data.json` and a plain filesystem copy is invisible
> to the runtime (you'll see "Projekt „main" existiert nicht"). The `iobroker file
> write` command registers the file the right way.

### Option B — import via VIS-2 editor

1. Open <http://HOST:8082/vis-2/edit.html>
2. Menu → Projects → Import → "from file"
3. Select `vis-views.json` from this folder
4. Save (Ctrl-S), reload runtime

### Adapt to your own camera IDs

The example uses the four camera UUIDs from the upstream developer's setup.
You'll need to replace them with your own. After the adapter has discovered
your cameras, list them:

```bash
iobroker list states "bosch-smart-home-camera.0.cameras.*.name"
```

Then in `vis-views.json`, find/replace each of the four UUIDs:

- `11111111-1111-1111-1111-111111111111` → your camera 1 ID
- `22222222-2222-2222-2222-222222222222` → your camera 2 ID
- `33333333-3333-3333-3333-333333333333` → your camera 3 ID
- `44444444-4444-4444-4444-444444444444` → your camera 4 ID

If you have fewer than four cameras, delete the unused widgets (`w00011`–
`w00015` for slot 3, `w00016`–`w00020` for slot 4).

## Live stream via go2rtc

If you have go2rtc installed (recommended for low-latency video):

1. In go2rtc config, add each camera's `stream_url` state value as a stream
   source. Example go2rtc.yaml:

```yaml
streams:
  bosch_terrasse:
    - rtsp://127.0.0.1:54321/rtsp_tunnel
```

2. In `vis-views.json`, replace the `tplImage` widget with `tplIframeDialog`
   pointing at the go2rtc WebRTC endpoint:

```json
{
  "tpl": "tplIframe",
  "data": {
    "src": "http://HOST:1984/api/stream.html?src=bosch_terrasse&mode=webrtc",
    "scrolling": "no"
  }
}
```

Latency drops to 1–2 seconds on LAN.

Note: the per-camera `stream_url` is regenerated each time the adapter opens
a new live session (e.g. after a restart, or after the 30 s session TTL
expires). Use go2rtc's `restart_on_error` or `exec` source instead of a
hardcoded port if you want self-healing.

## Layout reference

```
┌──────────────────────────────────────────────────────────────┐
│ Connection: true    FCM: healthy                             │
├───────────────────────────┬──────────────────────────────────┤
│  Terrasse                 │  Innenbereich                    │
│  [snapshot 560×315]       │  [snapshot 560×315]              │
│  [🔒 Privacy] [💡 Light]  │  [🔒 Privacy] [💡 Light]         │
│  [📷 Snapshot]            │  [📷 Snapshot]                   │
├───────────────────────────┼──────────────────────────────────┤
│  Kamera                   │  Haustüre                        │
│  [snapshot 560×315]       │  [snapshot 560×315]              │
│  [🔒 Privacy] [💡 Light]  │  [🔒 Privacy] [💡 Light]         │
│  [📷 Snapshot]            │  [📷 Snapshot]                   │
└───────────────────────────┴──────────────────────────────────┘
```

Total canvas: 1200 × 800 px. Built on the `basic` widget set (`tplImage`,
`tplValueString`, `tplBulbOnOff`) — no third-party widget packs required.

## Troubleshooting

**Snapshots stay black or show "missing"**
- Trigger a manual snapshot first: `iobroker state set
  bosch-smart-home-camera.0.cameras.<id>.snapshot_trigger true`
- Check the file exists: `ls ~/iobroker-data/files/bosch-smart-home-camera.0/cameras/<id>/snapshot.jpg`
- Verify the snapshot URL responds: `curl -I http://HOST:8082/bosch-smart-home-camera.0/cameras/<id>/snapshot.jpg`

**Snapshot URL returns HTTP 404 from VIS but works in browser**
- The snapshot file is only served through the `web` adapter on port 8082,
  not through admin on 8081. Make sure VIS-2 is using `web.0` as its
  backend (default).

**Privacy / Light toggles do nothing**
- These call the Bosch Cloud API directly — verify `info.connection` is
  `true` and that the access token is fresh (`info.token_expires_at`
  should be a future timestamp).
- Check the adapter log for the response: `iobroker logs bosch-smart-home-camera`
  should show `Privacy mode ON set for camera <id>` after each click.

**FCM status shows "stub" or "error"**
- `stub` means FCM is intentionally disabled (v0.2.0 behaviour). v0.3.0+
  registers automatically; if you're on v0.3.0 and seeing "stub",
  upgrade the adapter.
- `error` typically means Bosch rejected the FCM registration — restart
  the adapter, the access token may need to refresh first.
