# CI: the GitHub Action

`packages/action` is a composite GitHub Action plus the `receipts ci` entrypoint it calls. On a pull
request it picks scenarios, runs them, optionally publishes the evidence to your store, and reports back
with **one check run** and **one sticky comment**.

> **Status:** the Action has been exercised in **dry-run** and against a mocked GitHub API only. It has
> not been run on real GitHub-hosted runners yet. See [What isn't live-tested](#what-isnt-live-tested).

## Workflow

`receipts init` writes `.github/workflows/receipts.yml`:

```yaml
name: receipts
on:
  pull_request:            # never pull_request_target: fork PRs get no secrets
    types: [opened, synchronize, reopened, edited]
permissions:
  contents: read
  pull-requests: write
  checks: write
  id-token: write          # OIDC for the artifact bucket, if you use one
concurrency:
  group: receipts-${{ github.event.pull_request.number }}
  cancel-in-progress: true
jobs:
  evidence:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci
      - uses: ./node_modules/@receipts/action   # composite action from packages/action
        with:
          dry-run: 'false'
```

The composite step runs `npx playwright install --with-deps chromium` and then `npx receipts ci …`, so
the app repo needs `receipts`, `@receipts/core` and `@receipts/action` installed as dev dependencies.
Until they're on a registry, that means a git or vendored dependency.

### Inputs

| Input | Default | Meaning |
|---|---|---|
| `working-directory` | `.` | where `receipts.config.ts` lives |
| `scenarios` | (auto) | space-separated keys/globs/`@tags`; default = changed scenario files + Test Plan-mapped + `@smoke` |
| `all` | `false` | run every scenario |
| `base-url` | | target a preview environment instead of `webServer` |
| `dry-run` | `false` | write the comment and check to files; make no GitHub API calls |
| `comment-file` | | where to write the rendered comment |
| `annotate-pr-body` | `false` | append evidence links to Test Plan checkboxes in the PR body |
| `github-token` | `github.token` | needs `pull-requests: write` and `checks: write` |
| `upload-artifact` | `true` | also upload the bundle as an Actions artifact (private to repo members) |
| `retention-days` | `30` | artifact retention |

Outputs: `conclusion`, `run-dir`, `comment-file`.

## What it posts

- **Check run** `receipts/evidence`: `success` when every selected scenario passed, `failure` when any
  failed, `neutral` when nothing matched. The summary lists each scenario with its verdict counts.
- **One sticky comment**, found by the marker `<!-- receipts:sticky -->` and edited in place, never
  duplicated. It has a Test Plan table (✅ / ❌ / `manual` for unmapped items), per-scenario verdicts and
  highlights, links to the viewer (`viewerURL`) and a privacy note. When a new push starts a run, the
  previous comment is marked **stale** until the new results land.
- **Test Plan annotations** (opt-in): links appended to the matching `- [ ]` lines in the PR body.
  Receipts never ticks a checkbox for you.

## Dry-run locally

The demo has a script that fakes a `pull_request` event and runs the entrypoint without touching
GitHub:

```sh
cd examples/acme-learn
pnpm ci:dry-run
cat .receipts/ci/pr-comment.md         # the sticky comment
cat .receipts/ci/check-run.json        # the check run payload
```

Under the hood:

```sh
node scripts/fake-pr-event.mjs          # writes .receipts/ci/event.json from pr-body.md
pnpm exec receipts ci --event .receipts/ci/event.json --dry-run --no-publish \
  --annotate-pr-body --link-base http://127.0.0.1:4400 \
  --comment-out .receipts/ci/pr-comment.md --check-out .receipts/ci/check-run.json
```

`--no-publish` skips the store upload; `--link-base` sets where comment links point (for example your
local `receipts open --serve`).

## Security

- Use `pull_request`, not `pull_request_target`. Fork PRs then run without secrets, and Receipts
  doesn't publish anything for them.
- Give the job the minimum permissions above. If you publish to S3, use OIDC and a write-only role
  scoped to the repo's prefix rather than long-lived keys.
- Test users' credentials come from repository secrets passed as env vars; never commit storageState
  files.
- Evidence is private: the comment links to your viewer, which requires auth, and the Actions artifact
  is visible only to people with repo access.

## What isn't live-tested

- Running the Action on real GitHub-hosted runners, including `--with-deps` browser installs.
- Creating and updating real check runs and sticky comments (tested against a mocked API).
- `annotate-pr-body` against a real PR.
- Publishing to a real S3 bucket from CI with OIDC (S3 publishing was tested against an S3 emulator).
- Installing `receipts` from a git dependency in a consumer repo.
