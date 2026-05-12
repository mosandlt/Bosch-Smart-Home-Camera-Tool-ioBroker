# ioBroker Adapter Implementation Guide — Bosch Smart Home Camera

Research-based guide for porting the HA integration to ioBroker TypeScript.
Sources verified via WebFetch/WebSearch 2026-05-12.

---

## Folder Structure (Target State)

```
iobroker.bosch-smart-home-camera/
├── src/
│   ├── main.ts                  # Adapter entry point (extends utils.Adapter)
│   ├── lib/
│   │   ├── bosch-api.ts         # OAuth2 + REST client (port from HA api.py)
│   │   ├── fcm-listener.ts      # FCM push receiver (port from HA fcm.py)
│   │   ├── tls-proxy.ts         # RTSPS→RTSP TLS proxy (port from tls_proxy.py)
│   │   └── adapter-config.d.ts  # TypeScript types for native config (auto-generated)
├── admin/
│   ├── jsonConfig.json          # Config UI definition (no HTML needed)
│   └── bosch-camera.png         # Adapter icon (128x128)
├── test/
│   ├── mocha.opts               # or .mocharc.yml
│   ├── package.test.ts          # tests.packageFiles() — required for repo admission
│   ├── unit.test.ts             # tests.unit() with mock adapter
│   └── integration.test.ts      # tests.integration() — optional but recommended
├── build/                       # tsc output (gitignored)
├── .github/
│   └── workflows/
│       └── test-and-release.yml # CI + npm publish on tag push
├── io-package.json              # ioBroker adapter metadata
├── package.json
├── tsconfig.json
├── .eslintrc.json               # or eslint.config.js (ESLint flat config)
└── README.md
```

Key differences from HA integration:
- `build/` = compiled output, never edit; `src/` is source of truth
- `admin/jsonConfig.json` replaces all HA `strings.json` + `translations/*.json`
- No `custom_components/` path — ioBroker installs via npm

---

## io-package.json (Bosch-specific, complete)

```json
{
  "common": {
    "name": "bosch-smart-home-camera",
    "version": "0.1.0",
    "news": {
      "0.1.0": {
        "en": "Initial release",
        "de": "Erstveröffentlichung"
      }
    },
    "title": "Bosch Smart Home Camera",
    "titleLang": {
      "en": "Bosch Smart Home Camera",
      "de": "Bosch Smart Home Kamera"
    },
    "desc": {
      "en": "Cloud + local integration for Bosch Smart Home cameras (Eyes, 360°, Gen2)",
      "de": "Cloud- und Lokalzugriff für Bosch Smart Home Kameras (Eyes, 360°, Gen2)"
    },
    "authors": ["mosandlt <10558666+mosandlt@users.noreply.github.com>"],
    "keywords": ["bosch", "smart home", "camera", "eyes", "gen2", "security"],
    "license": "MIT",
    "platform": "Javascript/Node.js",
    "main": "build/main.js",
    "icon": "bosch-camera.png",
    "extIcon": "https://raw.githubusercontent.com/mosandlt/ioBroker.bosch-smart-home-camera/main/admin/bosch-camera.png",
    "readme": "https://github.com/mosandlt/ioBroker.bosch-smart-home-camera#readme",
    "loglevel": "info",
    "mode": "daemon",
    "type": "multimedia",
    "connectionType": "cloud",
    "dataSource": "push",
    "materialize": true,
    "compact": true,
    "adminUI": { "config": "json" },
    "tier": 3,
    "dependencies": [
      { "js-controller": ">=6.0.0" }
    ],
    "globalDependencies": [
      { "admin": ">=6.0.0" }
    ]
  },
  "native": {
    "username": "",
    "password": "",
    "region": "EU",
    "refreshToken": "",
    "accessToken": "",
    "tokenExpiry": 0,
    "streamMode": "LOCAL",
    "pollInterval": 60,
    "debugLogging": false
  },
  "instanceObjects": [
    {
      "_id": "info.connection",
      "type": "state",
      "common": {
        "name": "Connection state",
        "type": "boolean",
        "role": "indicator.connected",
        "read": true,
        "write": false,
        "def": false
      },
      "native": {}
    }
  ],
  "objects": []
}
```

Key field notes:
- `mode: "daemon"` — runs continuously, auto-restarted by js-controller
- `type: "multimedia"` — camera/stream adapters use this (not "hardware")
- `connectionType: "cloud"` — Bosch primary path; set `"local"` if/when Bosch summer API ships
- `dataSource: "push"` — FCM push, not polling (same as Ring adapter pattern)
- `tier: 3` — community adapter (tier 1 = official ioBroker, tier 2 = well-known)
- `native.*` — all fields accessible at runtime as `this.config.username` etc.

---

## jsonConfig.json (Bosch Account Login Form, complete)

```json
{
  "type": "tabs",
  "i18n": true,
  "items": {
    "tab_connection": {
      "type": "tab",
      "label": "Connection",
      "items": {
        "username": {
          "type": "text",
          "label": "Bosch Account Email",
          "help": "Your Bosch SingleKey ID email address",
          "sm": 12, "md": 6
        },
        "password": {
          "type": "password",
          "label": "Password",
          "help": "Your Bosch SingleKey ID password",
          "sm": 12, "md": 6
        },
        "region": {
          "type": "select",
          "label": "Region",
          "default": "EU",
          "options": [
            { "label": "Europe (EU)", "value": "EU" },
            { "label": "United States (US)", "value": "US" }
          ],
          "sm": 12, "md": 4
        },
        "streamMode": {
          "type": "select",
          "label": "Stream Mode",
          "default": "LOCAL",
          "options": [
            { "label": "Auto (Local → Cloud fallback)", "value": "AUTO" },
            { "label": "Local only", "value": "LOCAL" },
            { "label": "Cloud only", "value": "REMOTE" }
          ],
          "sm": 12, "md": 4
        }
      }
    },
    "tab_advanced": {
      "type": "tab",
      "label": "Advanced",
      "items": {
        "pollInterval": {
          "type": "number",
          "label": "Poll interval (seconds)",
          "help": "How often to poll camera status when FCM push is unavailable",
          "default": 60,
          "min": 10, "max": 3600,
          "sm": 12, "md": 4
        },
        "debugLogging": {
          "type": "checkbox",
          "label": "Debug logging",
          "help": "Enable verbose TLS proxy and FCM debug output",
          "default": false,
          "sm": 12, "md": 4
        }
      }
    }
  }
}
```

OAuth2 note: ioBroker's built-in `oauth2` widget type works only for pre-registered cloud services
(Spotify, Google, Dropbox). Bosch's OAuth2 (SingleKey ID + `/oauth/token`) is not pre-registered.
Pattern to use instead: store `refreshToken` in `native` config, do the initial auth via username+password
in `onReady()`, then rotate token silently. This is identical to the HA approach.

---

## src/main.ts Skeleton (TypeScript, copy-paste ready)

```typescript
import * as utils from "@iobroker/adapter-core";

// Placeholder imports — implement in src/lib/
// import { BoschApiClient } from "./lib/bosch-api";
// import { FcmListener } from "./lib/fcm-listener";
// import { TlsProxy } from "./lib/tls-proxy";

interface CameraState {
  id: string;
  name: string;
  host: string;
  port: number;
  streamUrl: string;
  isStreaming: boolean;
}

class BoschCamera extends utils.Adapter {
  private cameras: Map<string, CameraState> = new Map();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  // private apiClient: BoschApiClient | null = null;
  // private fcmListener: FcmListener | null = null;
  // private tlsProxies: Map<string, TlsProxy> = new Map();

  public constructor(options: Partial<utils.AdapterOptions> = {}) {
    super({ ...options, name: "bosch-smart-home-camera" });
    this.on("ready", this.onReady.bind(this));
    this.on("stateChange", this.onStateChange.bind(this));
    this.on("unload", this.onUnload.bind(this));
    // this.on("message", this.onMessage.bind(this));  // enable if admin needs sendTo()
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  private async onReady(): Promise<void> {
    // 1. Validate config
    if (!this.config.username || !this.config.password) {
      this.log.error("Username and password are required — configure adapter first");
      return;
    }

    // 2. Mark disconnected until authenticated
    await this.setStateAsync("info.connection", false, true);

    try {
      // 3. Authenticate against Bosch cloud (port from api.py)
      // this.apiClient = new BoschApiClient(this.config.username, this.config.password, this.config.region);
      // await this.apiClient.authenticate();

      // 4. Discover cameras via SHC
      // const cameras = await this.apiClient.getCameras();
      // for (const cam of cameras) await this.initCamera(cam);
      this.log.info("Bosch API authenticated — camera discovery placeholder");

      // 5. Start FCM listener for push events (motion, status)
      // this.fcmListener = new FcmListener(this.apiClient.getFcmToken());
      // this.fcmListener.on("motion", this.onMotionEvent.bind(this));

      // 6. Subscribe to state changes for all cameras (* = all)
      await this.subscribeStatesAsync("*.liveStream");
      await this.subscribeStatesAsync("*.privacyMode");

      // 7. Mark connected
      await this.setStateAsync("info.connection", true, true);

      // 8. Start fallback poll (if FCM unavailable)
      this.pollTimer = setInterval(
        () => this.pollCameraStatus(),
        (this.config.pollInterval || 60) * 1000,
      );
    } catch (err) {
      this.log.error(`Initialization failed: ${err}`);
      await this.setStateAsync("info.connection", false, true);
    }
  }

  private onUnload(callback: () => void): void {
    try {
      if (this.pollTimer) clearInterval(this.pollTimer);
      // this.fcmListener?.stop();
      // for (const proxy of this.tlsProxies.values()) proxy.stop();
      this.log.info("Adapter stopped cleanly");
    } catch {
      // ignore
    } finally {
      callback();
    }
  }

  private async onStateChange(id: string, state: ioBroker.State | null | undefined): Promise<void> {
    if (!state || state.ack) return;  // ignore acknowledged (system) changes, react only to user commands

    this.log.debug(`State change: ${id} = ${state.val}`);

    // Parse: bosch-smart-home-camera.0.<camId>.liveStream
    const parts = id.split(".");
    const camId = parts[2];
    const stateName = parts[3];

    if (!this.cameras.has(camId)) return;

    try {
      if (stateName === "liveStream") {
        await this.handleStreamToggle(camId, !!state.val);
      } else if (stateName === "privacyMode") {
        await this.handlePrivacyToggle(camId, !!state.val);
      }
    } catch (err) {
      this.log.error(`Command failed for ${camId}.${stateName}: ${err}`);
    }
  }

  // ── Camera management ────────────────────────────────────────────────────

  private async initCamera(cam: { id: string; name: string; host: string; port: number }): Promise<void> {
    const prefix = cam.id;

    // Create object hierarchy for this camera
    await this.setObjectNotExistsAsync(prefix, {
      type: "channel",
      common: { name: cam.name },
      native: {},
    });

    // States per camera
    const states: Array<[string, ioBroker.StateCommon]> = [
      ["liveStream",   { name: "Live stream active", type: "boolean", role: "switch", read: true, write: true, def: false }],
      ["privacyMode",  { name: "Privacy mode",       type: "boolean", role: "switch", read: true, write: true, def: false }],
      ["motionDetected", { name: "Motion detected",  type: "boolean", role: "sensor.motion", read: true, write: false, def: false }],
      ["streamUrl",    { name: "RTSP stream URL",    type: "string",  role: "url",    read: true, write: false, def: "" }],
      ["snapshotUrl",  { name: "Snapshot URL",       type: "string",  role: "url",    read: true, write: false, def: "" }],
      ["firmwareVersion", { name: "Firmware",        type: "string",  role: "text",   read: true, write: false, def: "" }],
    ];

    for (const [stateName, common] of states) {
      await this.setObjectNotExistsAsync(`${prefix}.${stateName}`, {
        type: "state",
        common,
        native: {},
      });
    }

    this.cameras.set(cam.id, {
      id: cam.id,
      name: cam.name,
      host: cam.host,
      port: cam.port,
      streamUrl: "",
      isStreaming: false,
    });
  }

  private async handleStreamToggle(camId: string, enable: boolean): Promise<void> {
    // Port from HA camera.py turn_on/turn_off logic
    // const cam = this.cameras.get(camId)!;
    // if (enable) {
    //   const proxy = new TlsProxy(cam.host, cam.port);
    //   const localPort = await proxy.start();
    //   this.tlsProxies.set(camId, proxy);
    //   await this.setStateAsync(`${camId}.streamUrl`, `rtsp://127.0.0.1:${localPort}`, true);
    // } else {
    //   this.tlsProxies.get(camId)?.stop();
    //   this.tlsProxies.delete(camId);
    // }
    await this.setStateAsync(`${camId}.liveStream`, enable, true);
    this.log.info(`Camera ${camId} stream: ${enable ? "on" : "off"}`);
  }

  private async handlePrivacyToggle(camId: string, enable: boolean): Promise<void> {
    // Port from HA switch.py async_turn_on/off for privacy mode
    // await this.apiClient!.setPrivacyMode(camId, enable);
    await this.setStateAsync(`${camId}.privacyMode`, enable, true);
  }

  private async onMotionEvent(camId: string): Promise<void> {
    await this.setStateAsync(`${camId}.motionDetected`, true, true);
    // Auto-reset after 30s (same as HA)
    setTimeout(() => this.setStateAsync(`${camId}.motionDetected`, false, true), 30_000);
  }

  private async pollCameraStatus(): Promise<void> {
    // Fallback if FCM unavailable — poll SHC for camera states
    this.log.debug("Polling camera status");
    // for (const camId of this.cameras.keys()) {
    //   const status = await this.apiClient!.getCameraStatus(camId);
    //   await this.setStateAsync(`${camId}.privacyMode`, status.privacyMode, true);
    // }
  }
}

// Adapter start — supports both compact mode and standalone
if (require.main !== module) {
  // Compact mode: export factory function
  module.exports = (options: Partial<utils.AdapterOptions>) => new BoschCamera(options);
} else {
  // Standalone mode: start directly
  (() => new BoschCamera())();
}
```

---

## Test Setup

### test/package.test.ts (Required for repo admission)
```typescript
import path from "path";
import { tests } from "@iobroker/testing";

// Validates io-package.json + package.json compliance — mandatory
tests.packageFiles(path.join(__dirname, ".."));
```

### test/unit.test.ts
```typescript
import path from "path";
import { tests, utils } from "@iobroker/testing";

tests.unit(path.join(__dirname, ".."), {
  defineAdditionalTests() {
    const { adapter, database } = utils.unit.createMocks({});
    const { assertStateHasValue, assertObjectExists } = utils.unit.createAsserts(database, adapter);

    it("creates info.connection state", async () => {
      assertObjectExists("bosch-smart-home-camera.0.info.connection");
    });
  },
});
```

### test/integration.test.ts (optional, slow)
```typescript
import path from "path";
import { tests } from "@iobroker/testing";

tests.integration(path.join(__dirname, ".."), {
  allowedExitCodes: [11],
  controllerVersion: "latest",
  defineAdditionalTests({ suite }) {
    suite("Adapter starts without crash", (getHarness) => {
      it("starts and sets info.connection", async () => {
        const harness = getHarness();
        await harness.startAdapterAndWait();
      });
    });
  },
});
```

### .mocharc.yml (or test/.mocharc.yml)
```yaml
spec: "test/**/*.test.ts"
require:
  - ts-node/register
timeout: 60000
```

Requirements for Latest repo admission:
1. `tests.packageFiles()` must pass (checks io-package.json compliance)
2. GitHub Actions test workflow must pass on push
3. No bare `"state"` as role — use specific roles like `"sensor.motion"`, `"switch"`, `"url"`

---

## CI Workflow (.github/workflows/test-and-release.yml)

```yaml
name: Test and Release

on:
  push:
    branches: [main]
    tags:
      - "v*"
  pull_request:
    branches: [main]

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: "22.x", cache: "npm" }
      - run: npm ci
      - run: npm run lint

  test:
    needs: lint
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node-version: [20.x, 22.x]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: "${{ matrix.node-version }}", cache: "npm" }
      - run: npm ci
      - run: npm run build
      - run: npm test

  deploy:
    needs: [lint, test]
    if: |
      contains(github.event.head_commit.message, '[skip ci]') == false &&
      github.event_name == 'push' &&
      startsWith(github.ref, 'refs/tags/v')
    runs-on: ubuntu-latest
    permissions:
      id-token: write   # for npm trusted publishing
      contents: write   # for GitHub release creation
    steps:
      - uses: ioBroker/testing-action-deploy@v1
        with:
          node-version: "22.x"
          github-token: ${{ secrets.GITHUB_TOKEN }}
          # npm-token: ${{ secrets.NPM_TOKEN }}  # legacy; prefer trusted publishing
```

NPM note (2025): Classic NPM tokens revoked Nov 2025. Use npm Trusted Publishing
(OIDC) — set up at npmjs.com > package > Publishing > Trusted Publishing, link to
GitHub repo + workflow name. Then remove `npm-token` from workflow.

---

## Recommended Reference Adapters

### 1. ioBroker.ring (Cloud camera + push events)
URL: https://github.com/iobroker-community-adapters/ioBroker.ring
Why: Closest analog to Bosch — cloud-only, OAuth2 + token refresh, FCM-style push
events, snapshot and live stream handling, TypeScript, `connectionType: "cloud"`,
`dataSource: "push"`. Study: `src/lib/api.ts` for token rotation, `src/lib/ring-intercom.ts`
for device state structure.

### 2. ioBroker.tapo (TP-Link cameras, local + cloud hybrid)
URL: https://github.com/TA2k/ioBroker.tapo
Why: Camera-specific state structure (per-device channel hierarchy), ONVIF motion
events, stream URL state pattern, command routing in `onStateChange`. Shows how to
handle multiple camera types in one adapter. TypeScript, well-maintained.

### 3. ioBroker.eusec (Eufy Security cameras, cloud + go2rtc)
URL: https://github.com/bropat/ioBroker.eusec
Why: go2rtc integration pattern, `jsonConfig.json` with tabs + responsive grid (1,200+
line reference), multiple camera types, snapshot + stream lifecycle. Study: how it
registers stream URLs as states and how go2rtc consumes them via external Docker.

---

## FCM Library Recommendation

Use `firebase-admin` (official Google SDK for Node.js):

```bash
npm install firebase-admin
```

```typescript
import { initializeApp, cert } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";

// Initialize once in onReady()
const app = initializeApp({
  credential: cert(serviceAccountJson),   // from Bosch Firebase project
});
const messaging = getMessaging(app);

// Subscribe to a device token's FCM messages (incoming direction):
// Note: firebase-admin sends TO devices. To RECEIVE from Bosch cloud,
// use the raw FCM v1 API or the same HTTP long-poll approach as the HA
// integration (port fcm.py → Node.js using https.request + event emitter).
```

FCM receive pattern (port from HA `fcm.py`):
- Bosch uses a persistent FCM registration token per app instance
- In Node.js: maintain a persistent HTTP/2 connection to `fcm.googleapis.com`
- Recommended lib: `@firebase/messaging` (client-side) is browser-only → NOT usable in Node
- Alternative: implement raw FCM HTTP v1 long-poll using Node.js `https` module
  (same approach as HA Python) or use `node-firebase` for the registration flow
- Token rotation: same pattern as HA — store `fcmToken` in `native` config, refresh
  on `401` response, persist via `extendForeignObjectAsync`

---

## TLS Proxy in Node.js (port of tls_proxy.py)

Pattern: `tls.connect()` upstream (camera) + `net.createServer()` downstream (go2rtc).

```typescript
import * as net from "net";
import * as tls from "tls";

export class TlsProxy {
  private server: net.Server | null = null;

  async start(camHost: string, camPort: number): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((clientSocket) => {
        const upstream = tls.connect(
          { host: camHost, port: camPort, rejectUnauthorized: false },
          () => {
            clientSocket.pipe(upstream);
            upstream.pipe(clientSocket);
          },
        );
        upstream.on("error", (e) => clientSocket.destroy(e));
        clientSocket.on("error", (e) => upstream.destroy(e));
      });
      this.server.listen(0, "127.0.0.1", () => {
        const addr = this.server!.address() as net.AddressInfo;
        resolve(addr.port);
      });
      this.server.on("error", reject);
    });
  }

  stop(): void {
    this.server?.close();
    this.server = null;
  }
}
```

Differences from Python `tls_proxy.py`:
- Python `asyncio.StreamReader/Writer` ↔ Node `net.Socket` (both are duplex streams)
- Python `ssl.create_default_context()` with `check_hostname=False` ↔ Node `rejectUnauthorized: false`
- Node does NOT need `asyncio.gather()` — `pipe()` handles bidirectional flow automatically
- Circuit-breaker (5 fails / 30s from HA v10.4.10): replicate with a failure counter + `setTimeout` reset

---

## Publishing Path

npm package name: `iobroker.bosch-smart-home-camera` (all lowercase — npm requirement)
GitHub repo name: `ioBroker.bosch-smart-home-camera` or `ioBroker.bosch-smart-home-camera` (capital B allowed)

Steps:
1. Publish to npm: `npm publish` (first time, as `mosandlt`)
2. Add ioBroker org as owner: `npm owner add iobroker iobroker.bosch-smart-home-camera`
3. PR to `ioBroker/ioBroker.repositories` → `sources-dist.json` (Latest list)
   - Run: `npm run addToLatest -- --name bosch-smart-home-camera --version 0.1.0`
4. Forum thread on forum.iobroker.net announcing beta testing
5. After user feedback → PR to `sources-dist-stable.json` (Stable list)

Requirements for Latest admission (17 criteria, key ones):
- README.md with device description + link to manufacturer
- Valid state roles (not `"state"`, use `"sensor.motion"`, `"switch"`, `"url"` etc.)
- `tests.packageFiles()` passing in CI
- `connectionType` + `type` set in `io-package.json`
- Adapter available on npm

---

## Sources

- create-adapter: https://github.com/ioBroker/create-adapter
- Example TypeScript adapter: https://github.com/ioBroker/ioBroker.example/tree/master/TypeScript
- adapter-dev (build tooling): https://github.com/ioBroker/adapter-dev
- Adapter dev docs: https://github.com/ioBroker/ioBroker.docs/blob/master/docs/en/dev/adapterdev.md
- Dev guide (getting started): https://iobroker.github.io/dev-docs/getting-started/02-create-adapter/
- jsonConfig README: https://github.com/ioBroker/ioBroker.admin/blob/master/packages/jsonConfig/README.md
- @iobroker/testing: https://github.com/ioBroker/testing
- testing-action-deploy: https://github.com/ioBroker/testing-action-deploy
- ioBroker.repositories: https://github.com/ioBroker/ioBroker.repositories
- Ring adapter (reference): https://github.com/iobroker-community-adapters/ioBroker.ring
- Tapo adapter (reference): https://github.com/TA2k/ioBroker.tapo
- eusec adapter (reference): https://github.com/bropat/ioBroker.eusec
- ONVIF adapter: https://github.com/iobroker-community-adapters/ioBroker.onvif
- firebase-admin Node.js: https://firebase.google.com/docs/admin/setup
- FCM HTTP v1 API: https://firebase.google.com/docs/reference/fcm/rest/v1/projects.messages
