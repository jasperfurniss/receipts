# Viewer and sharing

Evidence often shows real UI and test-account data, so Receipts keeps it private by default. There are
three ways to look at a run:

| How | Who can see it | Command |
|---|---|---|
| Static report | you (a local file) | `receipts open` |
| Local viewer | you (loopback only, no login) | `receipts open --serve` |
| Shared viewer | your team, behind auth | `receipts publish` + `receipts viewer --auth token\|header` |

## What the viewer shows

- A run list per repo, PR and commit.
- The run page: video with a seekable step timeline (click a step to jump to its chapter), screenshots,
  every check with its verdict (AI-judged checks labeled 🤖), console and network logs, the manifest.
- The **embedded Playwright Trace Viewer**, served from the bundled `playwright-core`. Traces never go
  to `trace.playwright.dev`.
- `/compare?a=<base prefix>&b=<head prefix>`: base vs head side by side, aligned by step, with a pixel
  diff of screenshots.
- Video is served with byte-range support so seeking works.

## Auth modes

```sh
receipts viewer [--host 127.0.0.1] [--port 4400] [--auth none|token|header] [--audit-log .receipts/audit.log]
```

- **`none`**: only allowed on a loopback address; the viewer refuses to start otherwise. This is what
  `receipts open --serve` uses.
- **`token`**: set `RECEIPTS_VIEWER_TOKEN` (16+ characters). Clients send `Authorization: Bearer <token>`,
  or open `/login?token=<token>` once, which sets an HttpOnly, `SameSite=Strict` cookie (the trace
  viewer's service worker needs a cookie). Fine for a small team or a tunnel; rotate the token if it leaks.
- **`header`**: put an identity-aware proxy in front, such as **oauth2-proxy**, Cloudflare Access or an
  internal gateway. The viewer trusts `X-Forwarded-Email` / `X-Auth-Request-Email` only from
  `--trusted-proxies` (default loopback), and can restrict by `--allowed-domains` and `--allowed-groups`
  (e.g. GitHub org teams via `X-Forwarded-Groups`).

```sh
oauth2-proxy --provider=github --github-org=acme --upstream=http://127.0.0.1:4400 \
  --set-xauthrequest --pass-user-headers …
receipts viewer --auth header --allowed-groups acme:web
```

Every view and download is appended to a JSONL audit log (`ts`, `user`, `method`, `path`, `status`).

## Stores

Configured with `store:` in `receipts.config.ts`. Bundles are laid out as
`<org>/<repo>/<pr-N | branch-name | local>/<sha>/<run-id>/…`, with `run.json` written last as the
"complete" marker.

```ts
store: { type: 'fs', dir: '.receipts/store' },
// or any S3-compatible bucket (AWS S3, MinIO, R2, …):
store: {
  type: 's3', bucket: 'my-receipts', region: 'us-east-1', prefix: 'evidence',
  endpoint: 'https://s3.example.internal',          // optional, for non-AWS
  accessKeyIdEnv: 'RECEIPTS_S3_KEY_ID',             // optional; otherwise the default AWS credential chain (OIDC, profiles…)
  secretAccessKeyEnv: 'RECEIPTS_S3_SECRET',
},
```

With S3, `receipts viewer --presign` redirects videos and screenshots to 10-minute signed URLs; traces
are always proxied so the trace viewer stays same-origin. Keep the bucket private, block public
access, and add a lifecycle rule (Receipts also has `receipts purge`).

## Publishing

```sh
receipts publish [run-id] [--pr <n>]
```

Before uploading anything, `publish`:

1. re-hashes every artifact against its `manifest.json` and refuses tampered or incomplete bundles;
2. scans `trace.zip`, `console.json` and `network.json` with the secret scanner and refuses if any
   token-like value survived scrubbing.

Then it uploads to the store under the PR (or branch) prefix. Files already in the store with the same sha256 are skipped,
so re-publishing is cheap. `receipts verify [run] [--head-sha <sha>]` performs the same integrity check
locally and tells you whether evidence is stale for a given head.

## Security notes

- **Use test accounts and test data.** Receipts records whatever the signed-in user can see.
- **Recording is limited to `allowHosts`** (local and internal-looking hosts by default). Widening it to
  production is a deliberate act.
- **Redaction happens in the page before frames are captured** (including inside shadow DOM), and
  screenshots are masked as well. Traces and logs are scrubbed of auth headers, cookies, storage
  values, secret patterns and redacted text; audio/video and large bodies are dropped. Check a sample
  before sharing widely; CSS can't reach closed declarative shadow roots or canvas content.
- **storageState files are credentials.** Keep them out of git, and delete them when done.
- **No public links.** The viewer has no anonymous mode off loopback, and PR comments only link to it.
- **AI is off by default.** When enabled it only receives the expectation text and redacted screenshots.
