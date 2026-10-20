# 🧾 Receipts

**Show your receipts.** Receipts turns the items in a pull request's *Test Plan* into scenarios that
run in a real browser, and hands back evidence for each one: a video with a chapter card per step,
screenshots, a Playwright trace, console and network logs, and a pass/fail verdict for every check.
Every bundle is bound to the exact commit SHA and hashed so it can be verified later.

It runs on your laptop, behind a private team viewer, or in CI on PRs. Nothing is public by default.

- **Deterministic first.** Scenarios are YAML that compile to plain Playwright code. Runs never call an LLM.
- **Evidence bound to a SHA.** Each bundle has a `manifest.json` with the commit, scenario hash, browser, flags, test user, and a sha256 for every artifact.
- **Never tick a box you didn't verify.** Test Plan items that no scenario covers stay `manual`.
- **Redact before bytes leave the browser.** PII selectors are blurred in the page (including inside shadow DOM), and auth headers, cookies, tokens and redacted text are scrubbed from traces and logs.
- **Playwright is the substrate.** No custom recorder.

## 5-minute quickstart (the demo app)

Requirements: **Node 20+**, **pnpm 10** via corepack, and **ffmpeg** (generates the demo's lesson video
and turns recordings into MP4s with chapter markers; without it you get WebM).

```sh
git clone git@github.com:jasperfurniss/receipts.git && cd receipts
corepack enable                 # provides the pinned pnpm
pnpm install
pnpm build
pnpm browsers                   # Playwright's Chromium, once per machine
pnpm test                       # unit tests (optional)

cd examples/acme-learn
pnpm media                      # generates the synthetic lesson video with ffmpeg
pnpm exec receipts run --all    # starts the demo app, runs 4 scenarios → .receipts/runs/<id>/
pnpm exec receipts open         # opens the HTML report in your browser
```

You should see `✅ 4/4 passed`. The demo, **acme-learn**, is a tiny fictional site: a lesson video that
resumes from saved progress behind a `resume-playback` flag, with scenarios for signed in, signed out
and flag off. Then try:

```sh
pnpm exec receipts open --serve                  # local viewer on http://127.0.0.1:4400 with the embedded Trace Viewer (Ctrl-C to stop)
pnpm exec receipts plan --body-file pr-body.md   # map a PR's Test Plan checkboxes to scenarios
pnpm ci:dry-run                                  # what CI would post → .receipts/ci/pr-comment.md + check-run.json, no GitHub calls
```

> Use `pnpm exec receipts` rather than `npx receipts`. Receipts isn't on the npm registry, and `npx`
> would go looking for an unrelated package there.

## Point it at your own app

Receipts isn't published to a registry yet, so run the CLI from your clone:

```sh
alias receipts="node /path/to/receipts/packages/cli/bin/receipts.js"
cd /path/to/your-app
receipts init      # receipts.config.ts, .receipts/scenarios/example.yml, .github/workflows/receipts.yml, .gitignore entries
# edit receipts.config.ts: baseURL (and webServer, or start the app yourself), test users, flag adapter, redaction
receipts doctor    # app reachable? test users ready? ffmpeg? Chromium? trace viewer?
receipts run example --headed
receipts new "Video resumes from saved progress"
receipts run video-resumes-from-saved-progress
receipts open
```

Your config imports `@receipts/core`; the CLI resolves that to its own copy, so nothing has to be
installed in your app. Receipts only records `localhost`, `127.0.0.1`, `*.local`, `*.internal` and
`*.test` unless you widen `allowHosts`. Start with [docs/getting-started.md](docs/getting-started.md).

## Docs

| Doc | What's in it |
|---|---|
| [getting-started.md](docs/getting-started.md) | Prereqs, install, build, `init`, `doctor`, first run, report and viewer |
| [scenarios.md](docs/scenarios.md) | The YAML format: steps, checks, variants, fixtures, examples |
| [config.md](docs/config.md) | `receipts.config.ts`: baseURL/webServer, test users and storageState, flag adapters, redaction, embedded players |
| [ci.md](docs/ci.md) | The GitHub Action, dry-run, the check run and sticky comment, what isn't live-tested |
| [viewer-and-sharing.md](docs/viewer-and-sharing.md) | Viewer auth modes, stores, `publish`, security notes |
| [architecture.md](docs/architecture.md) | Packages and how a run flows |

## CLI

| Command | What it does |
|---|---|
| `receipts init [--force]` | Adds `receipts.config.ts`, a sample scenario, the GitHub workflow and gitignore entries |
| `receipts doctor` | Checks config, app health, test users, flags, redaction, ffmpeg, Chromium, trace viewer |
| `receipts new <title>` | Scaffolds a scenario YAML |
| `receipts run [keys/globs/@tags…] [--all] [--headed] [--base-url <url>] [--fresh-personas]` | Runs scenarios (base + variants) and writes `.receipts/runs/<id>/` plus `report.html`. Exits 1 on failure |
| `receipts open [run] [--serve] [--port]` | Static report, or a loopback-only viewer over local runs |
| `receipts compile [--check] [--no-ai]` | YAML → `.receipts/compiled/<id>.spec.ts` for plain Playwright Test |
| `receipts steps:add "<instruction>" "<code>"` | Hand-write the code for a natural-language `do:` step |
| `receipts plan [--body-file f \| --pr n] [--draft] [--json]` | Maps `## Test Plan` checkboxes to scenarios' `covers:` |
| `receipts verify [run] [--head-sha]` | Re-hashes every artifact against its manifest; flags stale evidence |
| `receipts comment [run] [--out]` | Renders the sticky PR comment markdown locally |
| `receipts publish [run] [--pr n]` | Integrity + secret-scan gate, then uploads to the configured store |
| `receipts viewer [--auth none\|token\|header]` | Serves the self-hosted viewer over the store |
| `receipts ci [--dry-run] …` | The Action's entrypoint: select → run → publish → check + comment |
| `receipts purge [--older-than 30] [--pr n]` | Deletes old local runs and a PR's store objects |

## Repo layout

```
packages/core        scenario format, runner/recorder, redaction, manifest, compiler, stores, reports
packages/cli         the `receipts` command
packages/viewer      self-hosted viewer with auth, embedded Trace Viewer, compare view
packages/action      GitHub Action (composite) + CI entrypoint
examples/acme-learn  demo app and scenarios
docs/                guides and reference
```

## Roadmap and limitations

**Works today:** the CLI, YAML scenarios with variants, the recorder (video with chapters, screenshots,
trace, logs, manifest), redaction and scrubbing (including shadow DOM), test users via API sign-in,
functions or storageState, flag adapters, the HTML report, local and self-hosted viewer with auth, fs
and S3 stores, the Action in dry-run, unit tests.

**Not live-tested yet:** the Action on real GitHub (only dry-run and a mocked API), `publish` to a real
S3 bucket (tested against an S3 emulator), the OpenAI-compatible AI provider (mocked endpoint),
`header` auth behind a real oauth2-proxy.

**Not built yet:** registry packages, `receipts fix` (repair suggestions), MCP server mode, flake
detection and quarantine, rrweb replay, Slack/issue notifiers, Firefox/WebKit, mobile viewports,
preview-environment integration, inline images in PR comments (comments carry links only).

**Known rough edges:** video step offsets are measured from page creation (~100 ms drift); CSS
redaction can't reach closed declarative shadow roots or canvas content (screenshots are still
masked); `media` steps and checks need an element exposing `currentTime`/`play()` (see
[embedded players](docs/config.md#embedded-players-and-js-expression-checks)).

## License

MIT, see [LICENSE](LICENSE).
