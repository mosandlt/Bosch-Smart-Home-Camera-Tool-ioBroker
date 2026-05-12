# Testing & Quality Guide

## Quality Standards Overview

ioBroker has **no Bronze/Silver/Gold/Platinum scale** analogous to Home Assistant's Quality Scale.
The binary progression is: **Latest repo → Stable repo**, enforced by automated `repochecker` + human review.

| Dimension | ioBroker (Latest) | ioBroker (Stable) | HA Gold (reference) |
|---|---|---|---|
| Formal quality tiers | None | None | Bronze→Silver→Gold→Platinum |
| Test requirement | package + integration tests in CI | same + community forum thread | ≥80% coverage (Gold) |
| Coverage tooling | none mandated, c8/nyc optional | same | pytest-cov enforced |
| CI matrix | Node 22 + 24, Ubuntu/Windows/macOS | same | Python matrix, multiple OS |
| Automated gate | `@iobroker/repochecker` (100+ checks) | repochecker + nightly candidate scan | quality_scale.yaml |
| State roles | all states must have valid roles | same | entity platform rules |
| Translations | 11 languages in io-package.json | same | en.json minimum |
| Sentry | optional but encouraged | recommended | not applicable |
| npm ownership | `npm owner add bluefox iobroker.<name>` | same | PyPI trusted publishing |
| Forum thread | not required | required | not required |

**Practical ceiling for a well-tested adapter: 70–80% line coverage** is considered excellent in the ecosystem.
No ioBroker adapter enforces coverage as a CI gate today; the HA 99% bar does not exist here.

---

## Tests: 3 Layers

All three layers are already scaffolded in `package.json` (`test:js`, `test:package`, `test:integration`).

### Layer 1 — Unit Tests (Mocha + Chai + Sinon)

Unit tests run without any js-controller. They test pure TypeScript logic using sinon stubs for HTTP calls and `@iobroker/testing` mocks for the adapter object/state DB.

**Setup** (`test/unit/mocha.setup.ts` — create once):

```typescript
// Register ts-node for TypeScript test files
require("ts-node/register");
```

**Test file pattern** (`test/unit/digest.test.ts`):

```typescript
import { expect } from "chai";
import * as sinon from "sinon";
import axios from "axios";
import {
    parseDigestChallenge,
    buildDigestHeader,
    digestRequest,
} from "../../src/lib/digest";

describe("digest.ts", () => {
    let axiosStub: sinon.SinonStub;

    beforeEach(() => {
        axiosStub = sinon.stub(axios, "request" as any);
    });

    afterEach(() => sinon.restore());

    describe("parseDigestChallenge()", () => {
        it("parses MD5 challenge with qop=auth", () => {
            const header =
                'Digest realm="camera@bosch",nonce="abc123",qop="auth",algorithm=MD5';
            const result = parseDigestChallenge(header);
            expect(result.realm).to.equal("camera@bosch");
            expect(result.nonce).to.equal("abc123");
            expect(result.qop).to.equal("auth");
            expect(result.algorithm).to.equal("MD5");
        });

        it("throws on non-Digest scheme", () => {
            expect(() => parseDigestChallenge('Basic realm="x"')).to.throw(
                "Expected Digest scheme",
            );
        });

        it("throws when nonce is absent", () => {
            expect(() =>
                parseDigestChallenge('Digest realm="x"'),
            ).to.throw("missing required 'nonce'");
        });
    });

    describe("buildDigestHeader()", () => {
        it("produces valid Digest header for MD5 no-qop (legacy Bosch FW)", () => {
            const challenge = {
                realm: "cam",
                nonce: "nonce1",
                algorithm: "MD5",
            };
            const header = buildDigestHeader(
                "GET",
                "https://192.0.2.1/rcp/",
                "user",
                "pass",
                challenge,
            );
            expect(header).to.match(/^Digest /);
            expect(header).to.include('realm="cam"');
            expect(header).to.include("response=");
            expect(header).not.to.include("qop="); // no qop in legacy mode
        });

        it("includes qop=auth + nc + cnonce when challenge has qop", () => {
            const challenge = {
                realm: "cam",
                nonce: "n2",
                qop: "auth",
                algorithm: "MD5",
            };
            const header = buildDigestHeader(
                "PUT",
                "https://192.0.2.1/endpoint",
                "u",
                "p",
                challenge,
            );
            expect(header).to.include("qop=auth");
            expect(header).to.include("nc=");
            expect(header).to.include("cnonce=");
        });
    });

    describe("digestRequest()", () => {
        it("returns first response immediately when status is 200 (no auth needed)", async () => {
            axiosStub.resolves({
                status: 200,
                headers: { "content-type": "application/json" },
                data: Buffer.from('{"ok":true}'),
            });
            const resp = await digestRequest(
                "https://192.0.2.1/api",
                "u",
                "p",
            );
            expect(resp.status).to.equal(200);
            expect(axiosStub.callCount).to.equal(1);
        });

        it("performs two-step Digest flow on 401", async () => {
            axiosStub
                .onFirstCall()
                .resolves({
                    status: 401,
                    headers: {
                        "www-authenticate":
                            'Digest realm="r",nonce="n",algorithm=MD5',
                    },
                    data: Buffer.from(""),
                })
                .onSecondCall()
                .resolves({
                    status: 200,
                    headers: {},
                    data: Buffer.from("ok"),
                });

            const resp = await digestRequest("https://192.0.2.1", "u", "p");
            expect(resp.status).to.equal(200);
            expect(axiosStub.callCount).to.equal(2);
            const authHeader =
                axiosStub.secondCall.args[0].headers["Authorization"];
            expect(authHeader).to.match(/^Digest /);
        });

        it("throws when 401 response has no WWW-Authenticate header", async () => {
            axiosStub.resolves({
                status: 401,
                headers: {},
                data: Buffer.from(""),
            });
            await expect(
                digestRequest("https://192.0.2.1", "u", "p"),
            ).to.be.rejectedWith("without WWW-Authenticate");
        });
    });
});
```

**Test file pattern** (`test/unit/auth.test.ts`):

```typescript
import { expect } from "chai";
import * as sinon from "sinon";
import { AxiosInstance } from "axios";
import {
    generatePkcePair,
    buildAuthUrl,
    extractCode,
    refreshAccessToken,
    RefreshTokenInvalidError,
    AuthServerOutageError,
    KEYCLOAK_BASE,
    CLIENT_ID,
    REDIRECT_URI,
} from "../../src/lib/auth";

describe("auth.ts", () => {
    describe("generatePkcePair()", () => {
        it("returns verifier and challenge as non-empty strings", () => {
            const pair = generatePkcePair();
            expect(pair.verifier).to.be.a("string").with.length.greaterThan(40);
            expect(pair.challenge).to.be.a("string").with.length.greaterThan(20);
        });

        it("produces unique pairs on each call", () => {
            const a = generatePkcePair();
            const b = generatePkcePair();
            expect(a.verifier).to.not.equal(b.verifier);
        });
    });

    describe("buildAuthUrl()", () => {
        it("contains required PKCE + OAuth2 params", () => {
            const { challenge } = generatePkcePair();
            const url = buildAuthUrl(challenge, "mystate");
            expect(url).to.include(KEYCLOAK_BASE);
            expect(url).to.include(`client_id=${CLIENT_ID}`);
            expect(url).to.include("response_type=code");
            expect(url).to.include("code_challenge_method=S256");
            expect(url).to.include(`state=mystate`);
            expect(url).to.include(encodeURIComponent(REDIRECT_URI));
        });
    });

    describe("extractCode()", () => {
        it("returns the code param from a valid redirect URL", () => {
            const url = `${REDIRECT_URI}?code=abc123&state=s`;
            expect(extractCode(url)).to.equal("abc123");
        });

        it("returns null when error param is present", () => {
            const url = `${REDIRECT_URI}?error=access_denied`;
            expect(extractCode(url)).to.be.null;
        });

        it("returns null for unrelated URLs", () => {
            expect(extractCode("https://example.com/other")).to.be.null;
        });
    });

    describe("refreshAccessToken()", () => {
        let httpClient: sinon.SinonStubbedInstance<AxiosInstance>;

        beforeEach(() => {
            httpClient = sinon.stub({
                post: async () => ({}),
            } as unknown as AxiosInstance) as any;
        });

        afterEach(() => sinon.restore());

        it("returns new TokenResult on 200", async () => {
            (httpClient as any).post = sinon.stub().resolves({
                status: 200,
                data: {
                    access_token: "new_at",
                    refresh_token: "new_rt",
                    expires_in: 300,
                    refresh_expires_in: 86400,
                    token_type: "Bearer",
                    scope: "openid",
                },
            });
            const result = await refreshAccessToken(
                httpClient as unknown as AxiosInstance,
                "valid_rt",
            );
            expect(result?.access_token).to.equal("new_at");
        });

        it("throws RefreshTokenInvalidError on HTTP 401", async () => {
            (httpClient as any).post = sinon.stub().resolves({ status: 401 });
            await expect(
                refreshAccessToken(
                    httpClient as unknown as AxiosInstance,
                    "expired_rt",
                ),
            ).to.be.rejectedWith(RefreshTokenInvalidError);
        });

        it("throws AuthServerOutageError on HTTP 503", async () => {
            (httpClient as any).post = sinon.stub().resolves({ status: 503 });
            await expect(
                refreshAccessToken(
                    httpClient as unknown as AxiosInstance,
                    "rt",
                ),
            ).to.be.rejectedWith(AuthServerOutageError);
        });
    });
});
```

**`.mocharc.yml` update** (add unit test glob):

```yaml
# test/.mocharc.yml
require:
  - ts-node/register
spec:
  - test/unit/**/*.test.ts
timeout: 10000
exit: true
```

### Layer 2 — Integration Tests (@iobroker/testing)

Integration tests spin up a real js-controller instance in a temp directory, start the adapter, and assert that objects/states are created.

**`test/integration.js`** (already scaffolded as `test/package.js` pattern — replace):

```javascript
const path = require("path");
const { tests } = require("@iobroker/testing");

tests.integration(path.join(__dirname, ".."), {
    // Allow exit code 11 (adapter exits cleanly on missing config)
    allowedExitCodes: [11],
    // Optionally pin controller version:
    // controllerVersion: "latest",
    defineAdditionalTests({ suite }) {
        suite("Adapter startup", (getHarness) => {
            it("creates info.connection state", async () => {
                const harness = getHarness();
                await harness.startAdapterAndWait();

                // info.connection must exist after startup
                const state = await harness.states.getStateAsync(
                    "bosch-smart-home-camera.0.info.connection",
                );
                // State may be false if no credentials configured — that is OK
                // What matters is it exists and is acknowledged
                expect(state).to.not.be.null;
                expect(state?.ack).to.equal(true);
            });
        });
    },
});
```

### Layer 3 — Package Tests

Already in place at `test/package.js`. Validates `io-package.json` schema, required fields, and `package.json` consistency. Run via `npm run test:package`.

No changes needed unless repochecker surfaces E1xxx errors (see below).

---

## Coverage Target

### Tool: c8 (recommended over nyc)

c8 uses V8's native coverage — works correctly with TypeScript + ts-node without source map gymnastics.
nyc still works but does not natively support ESM.

**Add to `package.json`** devDependencies:

```json
"c8": "^10.1.3"
```

**Add coverage scripts**:

```json
"test:coverage": "c8 --reporter=text --reporter=lcov npm run test:js",
"coverage:report": "c8 report --reporter=html"
```

**`.c8rc.json`** (project root):

```json
{
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/*.d.ts", "src/lib/adapter-config.d.ts"],
  "extension": [".ts"],
  "all": true,
  "reporter": ["text", "lcov", "html"],
  "thresholds": {
    "statements": 60,
    "branches": 50,
    "lines": 60
  }
}
```

### Realistic Coverage Targets

| Phase | Coverage goal | Rationale |
|---|---|---|
| Pre-alpha (now) | 0% | No implementation yet |
| Alpha (auth + digest implemented) | 50–65% | Pure functions fully covered; adapter lifecycle not |
| Beta (cloud polling, state writes) | 65–75% | Integration path hard to mock |
| Stable submission | 70–80% | Ecosystem norm; no gate enforced |
| HA parity (99%) | Impractical | Would require full js-controller mock stack |

**Key difference from HA**: ioBroker has no formal coverage gate at any stage. 70% is excellent. 99% is not a realistic target without heroic mocking of the js-controller IPC layer.

---

## Repository Checks

### @iobroker/repochecker

Online: https://adapter-check.iobroker.in/

Local:

```bash
npx @iobroker/repochecker mosandlt/ioBroker.bosch-smart-home-camera
# With debug output:
npx @iobroker/repochecker mosandlt/ioBroker.bosch-smart-home-camera --debug
```

**Key error categories to pre-empt:**

| Code range | Category | Common failures for new adapters |
|---|---|---|
| E0050 | Blacklisted deps | `request`, deprecated packages |
| E0065–E0067 | @types/node mismatch | must align with `engines.node` |
| E1000–E1999 | io-package.json | missing tier, translations, instanceObjects |
| E3020–E3027 | CI Node matrix | must include Node 22 + 24 |
| E5049–E5050 | process.env in compact mode | use adapter.config instead |
| E6012–E6015 | README | no German words, no GitHub install instructions |
| E9505–E9507 | i18n not in package.json files | add admin/i18n/** to `files` array |

**Run before every Latest PR**. Zero errors required; warnings reviewed.

### CI Workflow Template

`.github/workflows/test-and-release.yml`:

```yaml
name: Test and Release

on:
  push:
    branches: [main]
    tags:
      - "v[0-9]+.[0-9]+.[0-9]+"
      - "v[0-9]+.[0-9]+.[0-9]+-**"
  pull_request: {}

concurrency:
  group: ${{ github.ref }}
  cancel-in-progress: true

jobs:
  check-and-lint:
    if: contains(github.event.head_commit.message, '[skip ci]') == false
    runs-on: ubuntu-latest
    steps:
      - uses: ioBroker/testing-action-check@v1
        with:
          node-version: "24.x"
          lint: true
          type-checking: true

  adapter-tests:
    needs: [check-and-lint]
    runs-on: ${{ matrix.os }}
    strategy:
      matrix:
        node-version: ["22.x", "24.x"]
        os: [ubuntu-latest, windows-latest, macos-latest]
    steps:
      - uses: ioBroker/testing-action-adapter@v1
        with:
          node-version: ${{ matrix.node-version }}
          build: true
          extra-tests: npm run test:js

  deploy:
    needs: [adapter-tests]
    runs-on: ubuntu-latest
    if: |
      contains(github.ref, 'refs/tags/v') &&
      github.event_name == 'push'
    permissions:
      contents: write
      id-token: write
    steps:
      - uses: ioBroker/testing-action-deploy@v1
        with:
          node-version: "22.x"
          npm-token: ${{ secrets.NPM_TOKEN }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
          # Sentry (add after obtaining DSN from @Apollon77):
          # sentry: true
          # sentry-token: ${{ secrets.SENTRY_AUTH_TOKEN }}
          # sentry-organization: iobroker
          # sentry-project: iobroker-bosch-smart-home-camera
```

**Notes:**
- `testing-action-check`, `testing-action-adapter`, `testing-action-deploy` are composite actions maintained by ioBroker that bundle the standard workflow steps.
- NPM trusted publishing (OIDC `id-token: write`) is included since Nov 2024; pass `npm-token` for traditional auth or omit for OIDC-only.
- Node matrix: 22.x + 24.x is the 2025 standard. Node 18 reaches EOL April 2025; drop from matrix.

---

## Latest → Stable Submission Path

| Step | Action | Effort | Time |
|---|---|---|---|
| 1 | Pass repochecker with 0 errors locally | 2–4h | 1 day |
| 2 | Publish to npm (`npm publish`) | 15 min | same day |
| 3 | Add ioBroker org as npm owner: `npm owner add bluefox iobroker.bosch-smart-home-camera` | 5 min | — |
| 4 | Fork ioBroker.repositories, run `npm run addToLatest -- --name bosch-smart-home-camera --type camera` | 30 min | — |
| 5 | Open Latest PR → automated repochecker comment | 1 day | — |
| 6 | Reviewer (Apollon77 / bluefox) merges | 1–4 weeks | depends on queue |
| 7 | Run adapter in production; open forum thread | 4–12 weeks | community testing |
| 8 | Run `npm run addToStable -- --name bosch-smart-home-camera --version x.y.z` | 30 min | after stability |
| 9 | Open Stable PR; link forum thread | 1–3 weeks review | — |

**Total realistic timeline: 3–6 months from first npm publish to Stable.**

---

## README Requirements

### Mandatory sections (English, E6012–E6015 checks)

```markdown
## Description
## Features
## Installation           ← DO NOT mention GitHub URL install / ioBroker CLI install commands
## Configuration          ← Screenshot of admin UI
## Changelog              ← MUST be present, semver-ordered, newest first
## License
```

### Rules enforced by repochecker

- No German words in README.md (E6015) — English only in root README.
  German translation goes to `docs/de/README.md`.
- No `ioBroker install` or `npm install` commands (E6012/E6013).
- License section must appear after Changelog.
- Changelog entries must be newest-first.

### Translation pattern

```
README.md            ← English (required, repochecker scans this)
docs/de/README.md    ← German (optional for Latest, recommended for Stable)
admin/i18n/          ← Auto-generated from io-package.json translations
```

### Screenshots

- Latest: 1+ screenshot of admin config dialog recommended.
- Stable: 3+ screenshots strongly recommended (camera stream view, config, states).

### Sentry notice (when DSN obtained)

Add at top of README, above all other content:

> This adapter uses Sentry libraries to automatically report exceptions and code errors to the developers.
> For more details and instructions on disabling error reporting, please refer to the [Sentry-Plugin Documentation](https://github.com/ioBroker/plugin-sentry#plugin-sentry).

---

## Reference Adapters Analysis

### 1. ioBroker.shelly (iobroker-community-adapters/ioBroker.shelly)

**Test setup:** Mocha + @iobroker/testing, 4 files (`integration.js`, `mocha.setup.js`, `mocharc.custom.json`, `package.js`).
**Coverage:** No coverage badge; c8/nyc not configured. Integration tests only — mocha + testing harness.
**CI:** Node 22 + 24, Ubuntu + Windows + macOS. `testing-action-adapter@v1` + `testing-action-check@v1`. Sentry integrated.
**Pattern to reuse:** Minimal integration test (`tests.integration(path.join(__dirname, ".."))`). No unit tests beyond package validation.
**Relevance for Bosch adapter:** Shelly has MQTT/CoAP protocol complexity; they rely on integration tests + good TypeScript types rather than unit tests. Same approach fits our OAuth2+Digest flows.

### 2. ioBroker.onvif (iobroker-community-adapters/ioBroker.onvif)

**Test setup:** Standard @iobroker/testing package + integration. No custom unit tests.
**Coverage:** Not reported.
**CI:** 3-job pipeline matching the template above.
**Relevance:** Direct camera protocol adapter (ONVIF RTSP). Authentication issues are the dominant bug class (basic auth, digest auth, token rotation). Zero test coverage for auth → repeated regressions. **Key lesson: test auth first.**

### 3. ioBroker.cameras (ioBroker/ioBroker.cameras)

**Test setup:** Minimal. Package test only.
**Coverage:** None.
**Known bugs from issues:**
- `#18`: Basic-auth headers not forwarded correctly → ECONNREFUSED
- `#77`: "Cannot set headers after they are sent" → uncaught exception crash
- `#200`: HTTPS config not applied to stream proxy
- `#201`: Stream not delivered to UI under specific proxy config
**Lessons:** Every one of these is a testable unit scenario. Our auth layer (digest.ts) must have exhaustive unit tests before any integration work starts.

---

## Recommended Test Plan for Bosch SHC Camera Adapter

### Tier A — Write immediately (as soon as implementation is done)

These test pure functions with no adapter infrastructure. Zero mocking overhead.

| File | Tests | Priority |
|---|---|---|
| `test/unit/digest.test.ts` | `parseDigestChallenge` (6 variants), `buildDigestHeader` (MD5/SHA-256/qop/no-qop), `digestRequest` (200 fast-path, 2-step 401, missing header error) | **HIGHEST** |
| `test/unit/auth.test.ts` | `generatePkcePair` (uniqueness, format), `buildAuthUrl` (all required params), `extractCode` (code, null-on-error, null-on-missing), `detectTokenClientId` (valid JWT, malformed) | **HIGHEST** |
| `test/unit/auth-refresh.test.ts` | `refreshAccessToken` (200 success, 400/401→RefreshTokenInvalidError, 5xx→AuthServerOutageError, network error→null) | **HIGHEST** |

**Expected coverage gain:** ~60% of `digest.ts` + ~70% of `auth.ts` pure functions.

### Tier B — Write at MVP (when cloud polling + state writes are implemented)

| File | Tests | Priority |
|---|---|---|
| `test/unit/camera-states.test.ts` | State role validation, object schema for each camera entity | High |
| `test/unit/fcm.test.ts` | FCM token parsing, push notification → motion event mapping | High |
| `test/integration.js` | Adapter starts with empty config → `info.connection=false`, no crash | Medium |

### Tier C — Write before Stable submission

| File | Tests | Priority |
|---|---|---|
| `test/unit/reconnect.test.ts` | Token refresh retry loop (3 attempts, backoff), outage-vs-invalid distinction | Medium |
| `test/unit/rtsp-url.test.ts` | RTSP URL builder for each camera generation (Gen1/Gen2, indoor/outdoor) | Medium |
| `test/integration-lifecycle.js` | Unload during active stream → no dangling timers | Low |

---

## Sources

- [@iobroker/testing GitHub](https://github.com/ioBroker/testing)
- [@iobroker/testing npm](https://www.npmjs.com/package/@iobroker/testing)
- [ioBroker.repositories README (requirements)](https://github.com/ioBroker/ioBroker.repositories)
- [Stable repo PR template](https://github.com/ioBroker/ioBroker.repositories/blob/master/.github/PULL_REQUEST_TEMPLATE/stable-repo.md)
- [ioBroker.repochecker](https://github.com/ioBroker/ioBroker.repochecker)
- [repochecker online](https://adapter-check.iobroker.in/)
- [ioBroker.cameras issues](https://github.com/ioBroker/ioBroker.cameras/issues)
- [ioBroker.shelly (reference adapter)](https://github.com/iobroker-community-adapters/ioBroker.shelly)
- [ioBroker.onvif (reference camera adapter)](https://github.com/iobroker-community-adapters/ioBroker.onvif)
- [plugin-sentry README](https://github.com/ioBroker/plugin-sentry/blob/master/README.md)
- [testing-action-adapter workflow](https://github.com/ioBroker/testing-action-adapter)
- [ioBroker adapter dev docs](https://github.com/ioBroker/ioBroker.docs/blob/master/docs/en/dev/adapterdev.md)
