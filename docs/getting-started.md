# Getting started

## Prerequisites

| Tool | Version | Why |
|---|---|---|
| Node.js | 20 or newer | runs everything |
| pnpm | 10 (pinned in `package.json`) | `corepack enable` provides it |
| Chromium for Playwright | matches the bundled Playwright | `pnpm browsers` installs it |
| ffmpeg | any recent | optional: WebM → MP4 with chapter markers, and the demo's `pnpm media` |

macOS: `brew install ffmpeg`. Debian/Ubuntu: `sudo apt-get install ffmpeg`.

## Install and build

```sh
git clone git@github.com:jasperfurniss/receipts.git
cd receipts
corepack enable
pnpm install
pnpm build       # tsc -b for core, viewer, action, cli
pnpm browsers    # = pnpm -C packages/core exec playwright install chromium
pnpm test        # vitest
```

Rebuild after pulling or editing `packages/*/src` (`pnpm build`; it's incremental).

## Run the demo

```sh
cd examples/acme-learn
pnpm media                     # writes the synthetic lesson video to media/lesson.webm (ffmpeg)
pnpm exec receipts run --all
```

The demo's `receipts.config.ts` has a `webServer` entry, so `run` starts `node server.js` on port 4173
when nothing answers `/healthz`, and stops it afterwards. Output:

```
.receipts/runs/<run-id>/
  run.json  report.html
  video-resume/             manifest.json verdicts.json video.mp4 shots/*.png trace.zip console.json network.json
  video-resume__flag-off/   …
  video-resume__signed-out/ …
  sign-in/                  …
```

`.receipts/runs/latest` points at the newest run.

## Open the report and the viewer

```sh
pnpm exec receipts open            # static report.html for the latest run, in your browser
pnpm exec receipts open <run-id>   # a specific run
pnpm exec receipts open --serve    # http://127.0.0.1:4400: run list, video with step timeline,
                                   # screenshots, embedded Playwright Trace Viewer, logs, manifest
```

`open --serve` binds to loopback only and needs no login. For a shared, authenticated viewer see
[viewer-and-sharing.md](viewer-and-sharing.md).

## Use it on your app

Receipts isn't on a registry yet. Run the CLI from your clone. Your config's `@receipts/core` import
is resolved to the CLI's own copy, so your app doesn't need new dependencies:

```sh
alias receipts="node /path/to/receipts/packages/cli/bin/receipts.js"
cd /path/to/your-app
receipts init
```

`init` writes:

- `receipts.config.ts`: base URL, how to start the app, test users, flag adapter, redaction ([config.md](config.md))
- `.receipts/scenarios/example.yml`: opens `/`, checks `main` is visible and there are no console errors
- `.github/workflows/receipts.yml`: the PR workflow ([ci.md](ci.md))
- `.gitignore` entries for runs, cached sign-ins and the local store

Edit `baseURL` (and `webServer`, or delete it and start the app yourself), then:

```sh
receipts doctor
```

`doctor` checks that the config loads, the app answers, each test user can sign in (or its storageState
file exists), and that ffmpeg, Chromium and the trace viewer are available. Fix anything red, then:

```sh
receipts run example --headed     # watch it once
receipts new "Video resumes from saved progress"
# edit .receipts/scenarios/video-resumes-from-saved-progress.yml (see scenarios.md)
receipts run video-resumes-from-saved-progress
receipts open
```

Tips:

- Point at an already-running app or a preview environment with `--base-url http://localhost:3100`
  (skips `webServer`). The host must be in `allowHosts`.
- `--headed` shows the browser. `--fresh-personas` forces test users to sign in again.
- Select scenarios by key (`video-resume` = base + all variants), variant (`video-resume/flag-off`),
  glob (`video-*`) or tag (`@smoke`).
- `receipts compile` writes `.receipts/compiled/*.spec.ts` if you want to run the same steps with plain
  `npx playwright test`.
