# 🧾 Receipts

**Show your receipts.** Turn each item in a PR's Test Plan into a scenario that actually runs, and get
video (with a chapter card per step), screenshots, a Playwright trace, console/network logs and a
pass/fail verdict for every check, all bound to the exact commit SHA. Runs on your laptop, behind a
private team viewer, or in CI on PRs. Nothing is public by default.

- **Deterministic first.** Scenarios are YAML compiled to plain Playwright code you commit. Runs never call an LLM.
- **Evidence bound to a SHA.** Every bundle has a `manifest.json` with the commit, scenario hash, browser, flags, persona, and a sha256 for every artifact.
- **Never tick a box you didn't verify.** Unmapped Test Plan items stay `manual`.
- **Redact before bytes leave the browser.** In-page blur for PII selectors (video, screenshots, trace snapshots) plus scrubbing of auth headers, cookies, tokens and PII text from traces and logs.
- **Playwright is the substrate.** No custom recorder.

```
packages/core     scenario format, runner/recorder, redaction, manifest, compiler, stores, reports
packages/cli      the `receipts` command
packages/viewer   self-hosted viewer (Node http server) with auth, embedded Trace Viewer, compare view
packages/action   GitHub Action (composite) + CI entrypoint (check run + one sticky comment)
examples/acme-learn  demo app: lesson video that resumes from saved progress behind `resume-playback`
```

## Quickstart (this repo)

Requirements: Node 20+, pnpm 10 (`corepack enable`), ffmpeg (optional, for MP4 + chapters).

```sh
pnpm install
pnpm build
npx playwright install chromium        # once per machine
pnpm test                              # unit tests

cd examples/acme-learn
pnpm media                             # generates the synthetic lesson video (ffmpeg)
npx receipts run --all                 # starts the demo app, runs 4 scenarios, writes .receipts/runs/<id>/
npx receipts open                      # static HTML report (opens in your browser)
npx receipts open --serve              # same, served on 127.0.0.1:4400 with the embedded Trace Viewer
npx receipts plan --body-file pr-body.md
npx receipts ci --event .receipts/ci/event.json --dry-run --no-publish --link-base http://127.0.0.1:4400
npx playwright test                    # optional: run the compiled specs with plain Playwright Test
```

## Quickstart (your app)

```sh
npm i -D receipts @receipts/core @playwright/test   # (from this monorepo: see "Using it in another repo")
npx playwright install chromium
npx receipts init          # receipts.config.ts, .receipts/scenarios/example.yml, .github/workflows/receipts.yml
npx receipts doctor        # app reachable? personas sign in? ffmpeg? trace viewer?
npx receipts new "Video resumes from saved progress"
npx receipts run video-resumes-from-saved-progress --headed
npx receipts open
```

### Using it in another repo before it's on a registry

```sh
cd /path/to/receipts && pnpm install && pnpm build
cd /path/to/your-app
npm i -D /path/to/receipts/packages/core /path/to/receipts/packages/cli @playwright/test@1.64.1
# or: pnpm add -D link:/path/to/receipts/packages/cli link:/path/to/receipts/packages/core
```

The CLI also resolves `@receipts/core` imports in your config to its own copy, so `npx receipts` works
even if only the CLI is installed.

## CLI

| Command | What it does |
|---|---|
| `receipts init [--force]` | Adds `receipts.config.ts`, `.receipts/scenarios/example.yml`, the GH workflow, and gitignore entries |
| `receipts new <title>` | Scaffolds a scenario YAML |
| `receipts run [keys/globs/@tags…] [--all] [--headed] [--base-url <url>] [--fresh-personas]` | Runs scenarios (base + variants) and writes `.receipts/runs/<id>/` plus `report.html`. Exits 1 on failure |
| `receipts open [run] [--serve] [--port]` | Static report, or a loopback-only viewer over local runs with the embedded Trace Viewer |
| `receipts compile [--check] [--no-ai]` | YAML → `.receipts/compiled/<id>.spec.ts` (deterministic). `do:` steps use cached code from `steps.json`; with an AI provider configured, missing ones are compiled once. `--check` fails CI if output is stale |
| `receipts steps:add "<instruction>" "<code>"` | Hand-write the code for a `do:` step (no AI needed) |
| `receipts plan [--body-file f \| --pr n] [--draft] [--json]` | Parses `## Test Plan` checkboxes and fuzzy-maps them to `covers:`. `--draft` writes skeleton (or AI-drafted) scenarios for unmapped items to `scenarios/drafts/` |
| `receipts verify [run] [--head-sha]` | Re-hashes every artifact against its manifest; flags stale evidence |
| `receipts comment [run] [--body-file] [--head-sha] [--out]` | Renders the sticky PR comment markdown locally |
| `receipts publish [run] [--pr n]` | Integrity + secret-scan gate, then uploads the bundle to the configured store under `org/repo/pr-<n>/<sha>/<run-id>/` |
| `receipts viewer [--auth none\|token\|header] [--host] [--port] [--presign]` | Serves the self-hosted viewer over the configured store |
| `receipts ci [--event] [--dry-run] [--comment-out] [--check-out] [--annotate-pr-body] [--no-publish]` | Action entrypoint: select → run → publish → check + sticky comment |
| `receipts doctor` | Checks config, app health, personas, flags, redaction, ffmpeg, Chromium, trace viewer |
| `receipts purge [--older-than 30] [--pr n]` | Deletes old local runs, and store objects for a PR |

Scenario selection: `video-resume` (base + all variants), `video-resume/flag-off`, globs (`video-*`, `*/signed-*`), tags (`@smoke`).

## Scenario reference

Scenarios live in `.receipts/scenarios/*.yml`. One file = one scenario + its variants; each variant
runs as its own scenario with its own evidence.

```yaml
id: video-resume                       # slug; variants become video-resume/<variant-id>
title: Lesson video resumes from saved progress
tags: [smoke, video]
covers:                                # Test Plan checkbox text this proves (fuzzy-matched)
  - "Signed-in learner: watch ~40s, leave, return"
persona: learner                       # from receipts.config.ts personas; `anonymous` = signed out
flags: { resume-playback: on }         # on/off/true/false or any string value
viewport: { width: 1280, height: 720 }
fixtures: { lesson: intro-to-typography }   # {{lesson}} in any string; {{env.NAME}} reads env
setup:                                 # runs before the first chapter (not in the timeline)
  - id: reset
    api: { method: DELETE, url: "/api/me/progress/lessons/{{lesson}}" }
steps:
  - id: open
    chapter: Open lesson                # title card in the video + step name everywhere
    goto: /lessons/{{lesson}}
    expect:
      - visible: { role: region, name: Lesson video }
    capture: opened                     # screenshot (redacted) after the step
variants:
  - id: flag-off
    covers: ["Flag off → video starts at 0:00"]
    flags: { resume-playback: off }
    override_last_expect: [ { media: { lte: 1 } } ]
  - id: signed-out
    persona: anonymous
    skip_steps: [reset]
    override_steps: { open: { chapter: Open lesson signed out } }
redact: [".avatar"]                     # extra selectors for this scenario
```

> YAML gotcha: quote values that contain `{{…}}` inside `{ … }` flow maps.

**Step keys** (combine freely; order of execution is: action → wait → expect → capture):

| Key | Example |
|---|---|
| `chapter` | `chapter: Return to the lesson` |
| `goto`, `reload: true`, `back: true` | `goto: /courses` (relative to baseURL; host allowlist enforced) |
| `click`, `dblclick`, `hover`, `check`, `uncheck` | `click: { role: button, name: Play }` |
| `fill` | `fill: { target: { label: Email }, value: "{{email}}" }` (values typed into password-ish fields are scrubbed from traces) |
| `press`, `select` | `press: Enter` · `press: { target: "#q", key: Enter }` · `select: { target: "#plan", value: pro }` |
| `flag` | `flag: { resume-playback: off }` (re-applies adapters, reloads) |
| `signIn`, `signOut` | `signIn: learner` · `signOut: true` |
| `api` | `api: { method: PUT, url: /api/x, data: {…}, expectStatus: 200 }` (shares the page's cookies) |
| `eval` / `evaluate` | `eval: "window.scrollTo(0, 0)"` |
| `media` | `media: { selector: video, muted: true, seek: 40, play: true, waitForTime: 42 }` · `pause: true` |
| `sleep` | `sleep: 500` |
| `wait` / `waitFor` | `{ selector: video, state: attached }` · `{ url: "**/done" }` · `{ load: networkidle }` · `{ request: "**/api/x", method: PUT }` · `1000` |
| `do` | Natural language, compiled once (AI or `steps:add`), cached in `.receipts/compiled/steps.json` by hash |
| `capture` / `screenshot` | `capture: resumed` · `{ name: full, fullPage: true }` |

Targets: a Playwright selector string, or `{ role, name, exact }`, `{ text }`, `{ label }`, `{ testId }`,
`{ placeholder }`, `{ selector }`. `name`/`text`/`label` accept `/regex/flags`.

**Assertions** (`expect:` list; each polls up to `expectTimeout`, default 5 s, or its own `timeout`):

| Assertion | Example |
|---|---|
| `visible` / `hidden` | `visible: { text: "/Resuming from 0:4\\d/" }` |
| `text` | `text: { target: h1, contains: "Typography" }` · `equals` · `matches: "/re/"` |
| `url`, `title` | `url: "**/courses"` · `title: "/Acme/"` |
| `eval` | `eval: "document.querySelector('video').currentTime < 1"` (truthy) |
| `request` | `request: { method: PUT, url: "/api/me/progress/**", times: ">=1" }` (counts since scenario start; `0`/`<n` settle 750 ms first) |
| `console` | `console: { errors: 0, warnings: 2 }` (page errors count as errors) |
| `media` | `media: { time: 42, tolerance: 3 }` · `{ gte: 10 }` · `{ lte: 1 }` · `{ paused: true }` |
| `judge` | `judge: "Shows a 'Resuming from' note near 0:42"` (🤖 AI-judged, off by default, labeled separately; never fails unless `ai.judge.canFail`) |

Iframe players (YouTube/Vimeo) aren't native `<video>`: expose a test hook such as
`window.__player.getCurrentTime()` and use `eval`.

## Config reference (`receipts.config.ts`)

```ts
import { defineConfig } from '@receipts/core';

export default defineConfig({
  baseURL: 'http://localhost:3000',                 // or RECEIPTS_BASE_URL / --base-url
  scenariosDir: '.receipts/scenarios', outDir: '.receipts',
  allowHosts: ['localhost', '127.0.0.1', '*.local', '*.internal', '*.test'],   // refuses to record anything else
  viewport: { width: 1280, height: 720 }, headless: true,
  expectTimeout: 5000, actionTimeout: 10000,
  video: { enabled: true, mp4: true },              // WebM → H.264 MP4 with chapter markers (ffmpeg)
  chapters: { enabled: true, holdMs: 900 },         // title card per step, then a corner badge
  trace: { screenshots: false, maxBodyBytes: 1 << 20 },   // media + big bodies omitted from traces
  webServer: { command: 'npm run dev', url: 'http://localhost:3000/healthz', reuseExisting: true, timeout: 120000 },
  personas: {
    learner: {
      label: 'Synthetic learner',
      signIn: { request: { method: 'POST', url: '/api/session', data: { email: process.env.E2E_EMAIL, password: process.env.E2E_PASSWORD } } },
      // or: signIn: async ({ page, request, context, baseURL }) => { … }
      // or: storageState: 'personas/learner.json'
      maxAgeMinutes: 30,                            // cached in .receipts/personas/<name>.json (gitignored)
    },
  },
  flags: {
    adapters: [
      { type: 'cookie', name: 'feature_flags', encode: 'json' },   // json | csv | (flags) => string
      // { type: 'localStorage', key: 'flags' }
      // { type: 'query', param: 'flags', encode: 'csv' }           // appended to every goto
      // { type: 'header', name: 'x-feature-flags' }
      // { type: 'route', url: '**/api/flags', transform: (body, flags) => ({ ...body, ...flags }) }
      // { type: 'custom', apply: async ({ context, baseURL, flags }) => { … }, transformUrl: (u, f) => u }
    ],
    readResolved: (page) => page.evaluate(() => (window as any).__flags),   // recorded in the manifest
  },
  redact: {
    selectors: ['[data-testid=account-menu]', '.user-email'],    // plus [data-receipts-redact] always
    attribute: 'data-receipts-redact', style: 'blur',            // or 'solid'
    headers: ['x-tenant-key'],                                   // + Authorization, Cookie, Set-Cookie, x-api-key, …
    patterns: ['acme_[a-z0-9]{24}'],                             // + JWT, sk_*, ghp_*, AKIA…, Bearer, ?token=…
    dropBodiesFor: ['**/api/me/profile'],
  },
  store: { type: 'fs', dir: '.receipts/store' },
  // store: { type: 's3', bucket: 'receipts', region: 'us-east-1', prefix: 'evidence', endpoint?: 'https://…', accessKeyIdEnv?: '…', secretAccessKeyEnv?: '…' },
  viewerURL: 'https://receipts.internal.example',   // links in PR comments
  repo: 'org/repo',                                 // store layout; defaults to $GITHUB_REPOSITORY / git remote
  ai: {                                             // everything AI is off unless configured AND keyed
    provider: { type: 'openai-compatible', baseURL: 'https://api.openai.com/v1', model: 'gpt-4.1-mini', apiKeyEnv: 'RECEIPTS_AI_KEY' },
    // or a custom object: { name, judge?(req), compileStep?(req), draftScenario?(req) }
    judge: { enabled: false, canFail: false },
  },
});
```

## Evidence bundle

```
.receipts/runs/<run-id>/
  run.json  report.html
  <scenario>[__<variant>]/
    manifest.json   # SHA, scenario hash, compiled-spec hash, browser, persona, requested + resolved flags,
                    # steps (video offsets), every assertion (AI-judged flagged), redaction + scrubber stats,
                    # sha256 of every artifact, limitations, manifestHash
    verdicts.json   video.mp4 (or .webm)   shots/NN-<name>.png   trace.zip   console.json   network.json
```

`receipts verify` re-hashes everything; `publish` refuses tampered bundles or any residual secret.

## Viewer (shared mode)

`receipts viewer` lists runs from the store; the run page shows video with a seekable step timeline,
screenshots, the **embedded Playwright Trace Viewer** (served from `playwright-core`, never
trace.playwright.dev), logs and the manifest. `/compare?a=<base prefix>&b=<head prefix>` shows
base vs head aligned by step with a pixelmatch diff. Video supports byte ranges; every view/download is
appended to a JSONL audit log.

Auth modes:
- `none`: only on loopback (refuses otherwise). Used by `receipts open --serve`.
- `token`: `RECEIPTS_VIEWER_TOKEN` (16+ chars). Send `Authorization: Bearer …`, or open `/login?token=…` once to set an HttpOnly, SameSite=Strict cookie (needed for the trace viewer's service worker).
- `header`: put **oauth2-proxy** (or Cloudflare Access / an internal gateway) in front. Trusts `X-Forwarded-Email` / `X-Auth-Request-Email` only from `--trusted-proxies` (default loopback), with optional `--allowed-domains` and `--allowed-groups` (e.g. GitHub org teams via `X-Forwarded-Groups`).

```sh
oauth2-proxy --provider=github --github-org=acme --upstream=http://127.0.0.1:4400 --set-xauthrequest --pass-user-headers ...
npx receipts viewer --auth header --allowed-groups acme:web
```

With an S3 store, `--presign` redirects media to 10-minute signed URLs (traces are always proxied so the
trace viewer stays same-origin).

## GitHub Action

```yaml
# .github/workflows/receipts.yml (written by `receipts init`)
on: pull_request            # not pull_request_target; fork PRs get no secrets and nothing is published
permissions: { contents: read, pull-requests: write, checks: write, id-token: write }
jobs:
  evidence:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
      - uses: ./node_modules/@receipts/action      # composite action in packages/action
        with: { dry-run: 'false' }
```

Selection is changed scenario files + scenarios mapped to Test Plan items + `@smoke` (or `scenarios:` /
`all: true`). Output: a `receipts/evidence` check run (success / failure / neutral when nothing
matched) and **one sticky comment** (`<!-- receipts:sticky -->`) edited in place, flipped to "stale"
while a new push re-runs. `annotate-pr-body: true` appends evidence links to Test Plan checkboxes (off by
default). The bundle is also uploaded as an Actions artifact (zero-infra fallback).
`dry-run: true` writes `pr-comment.md` and `check-run.json` and makes zero GitHub API calls.

## Security model (short)

- Test personas only, a hostname allowlist, and no UI logins in video unless the scenario is about login.
- PII selectors are blurred in-page before frames are captured; screenshots also use Playwright `mask`.
  Text inside redacted elements, every cookie value, persona storage values and password fills are
  removed from trace DOM snapshots, network events and logs. Audio/video and large bodies are omitted.
- Publishing is gated on artifact integrity and a residual-secret scan.
- AI is off by default; when enabled it only sees the expectation and redacted screenshots.

## Not done yet / limitations

- `receipts fix` (repair suggestions), MCP server mode, flake detection/quarantine, rrweb replay,
  Slack/issue notifiers, Firefox/WebKit, mobile viewports, ephemeral preview-env integration.
- The OpenAI-compatible provider is only tested against a mocked endpoint.
- Inline images in PR comments (orphan-branch thumbnails) are not implemented: comments carry links only.
- Video step offsets are measured from page creation (~100 ms drift).
