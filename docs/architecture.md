# Architecture

```
packages/core     the library: scenario format, runner/recorder, redaction + scrubbing, manifest,
                  compiler, stores, reports, Test Plan parsing, AI judge interface
packages/cli      `receipts`: commander CLI over core (init, doctor, run, open, compile, plan, publish, …)
packages/viewer   Node http server: run list, run page, embedded Trace Viewer, compare, auth, audit log
packages/action   composite GitHub Action + `receipts ci` entrypoint (selection, check run, sticky comment)
examples/acme-learn   demo app (Express + static pages) with scenarios and compiled specs
```

All TypeScript, ESM, built with `tsc -b` (project references), tested with vitest. Playwright is the
only browser dependency.

## Key modules in `core`

| Module | Role |
|---|---|
| `config.ts` | `defineConfig`, loading `receipts.config.ts` with jiti, defaults, paths |
| `scenario/schema.ts`, `parse.ts` | zod schema for the YAML; fixtures, flag normalization, variant expansion |
| `runner/run.ts` | `runScenarios` / `runOne`: the recorder (below) |
| `runner/overlay.ts` | chapter title cards and the corner badge drawn into the page |
| `runner/redact.ts` | redaction CSS injection (document + shadow roots), redacted-text collection |
| `runner/flags.ts` | flag adapters (`FlagApplier`) |
| `runner/personas.ts` | test-user sign-in and storageState caching |
| `runner/assertions.ts` | checks with polling; produces `AssertionResult`s |
| `runner/webserver.ts` | start/stop the app for `webServer` |
| `scrub.ts` | header/cookie/token/PII scrubbing of traces and logs; secret scanner |
| `media.ts` | ffmpeg WebM → MP4 with chapter metadata |
| `manifest.ts` | manifest types, `sealManifest`, `verifyBundle`, run summary |
| `compile/` | YAML → Playwright Test specs; cached `do:` step code |
| `store/` | `fs` and `s3` stores, key layout |
| `publish.ts` | integrity + secret gate, upload |
| `report/` | static HTML report, PR comment and check-run rendering |
| `testplan.ts` | parse `## Test Plan` checkboxes, fuzzy-map to `covers:` |
| `judge.ts` | optional AI provider interface (OpenAI-compatible or custom) |

## How a run flows

```
receipts run video-resume
  │
  ├─ load config (jiti) ─ resolve scenarios: parse YAML → validate → expand variants → apply fixtures
  ├─ start webServer (unless --base-url or already up) ─ check baseURL against allowHosts
  ├─ launch Chromium
  └─ for each scenario/variant:
       ├─ test user: storageState missing + ifMissing:skip → record as skipped, continue
       │             otherwise sign in once (API / function / file), cache storageState
       ├─ new browser context: viewport, storageState, recordVideo, tracing (snapshots on)
       ├─ init scripts: chapter overlay, redaction CSS (+ shadow roots)
       ├─ flag adapters: cookies / localStorage / headers / routes; URL transforms on every navigation
       ├─ setup steps (outside the timeline)
       ├─ steps: chapter card → action → wait → checks (polling) → redacted screenshot
       │         console + network captured; video offset recorded per step
       ├─ read resolved flags from the page
       ├─ stop tracing → scrub trace.zip, console.json, network.json
       ├─ close context → WebM → MP4 with chapters (ffmpeg, if available)
       ├─ optional AI judge for `judge:` checks (redacted screenshots only)
       └─ write verdicts.json + manifest.json (sha256 of every artifact, then the manifest's own hash)
  ├─ write run.json + report.html, update .receipts/runs/latest
  └─ stop webServer; exit 1 if anything failed
```

## CI flow (`receipts ci`)

```
read the pull_request event → parse Test Plan → select scenarios
  (changed scenario files ∪ Test Plan-mapped ∪ @smoke, or --scenarios/--all)
→ mark the sticky comment stale → run → publish (not for forks, not with --no-publish)
→ render check run + sticky comment → create/update via the GitHub API (or write files in --dry-run)
```

## Evidence bundle

```
.receipts/runs/<run-id>/
  run.json  report.html
  <scenario>[__<variant>]/
    manifest.json   # SHA, scenario hash, compiled-spec hash, browser, persona, requested + resolved flags,
                    # steps with video offsets, every check (AI-judged flagged), redaction + scrubber stats,
                    # sha256 of every artifact, limitations, manifestHash
    verdicts.json  video.mp4 (or .webm)  shots/NN-<name>.png  trace.zip  console.json  network.json
```
