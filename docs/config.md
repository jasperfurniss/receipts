# Configuration (`receipts.config.ts`)

Receipts looks for `receipts.config.ts` (or `.mts`/`.js`/`.mjs`) in the current directory, or takes
`-c <file>`. Paths in the config are relative to the config file. Everything is optional except what
your scenarios use.

## Full reference

```ts
import { defineConfig } from '@receipts/core';

export default defineConfig({
  baseURL: 'http://localhost:3000',          // overridden by RECEIPTS_BASE_URL or --base-url
  scenariosDir: '.receipts/scenarios',
  outDir: '.receipts',                       // runs/, personas/, compiled/, store/
  allowHosts: ['localhost', '127.0.0.1', '*.local', '*.internal', '*.test'],   // refuses to record anything else
  viewport: { width: 1280, height: 720 },
  headless: true,
  expectTimeout: 5_000,                      // default per-check polling timeout
  actionTimeout: 10_000,                     // clicks, fills, waits
  video: { enabled: true, mp4: true },       // WebM → H.264 MP4 with chapter markers (needs ffmpeg)
  chapters: { enabled: true, holdMs: 900 },  // title card per step, then a corner badge
  trace: { screenshots: false, maxBodyBytes: 1 << 20 },   // audio/video and bodies over 1 MiB are left out
  webServer: { command: 'npm run dev', url: 'http://localhost:3000/healthz', reuseExisting: true, timeout: 120_000 },
  personas: { /* test users, below */ },
  flags: { adapters: [ /* below */ ], readResolved: async (page) => ({}) },
  redact: { /* below */ },
  store: { type: 'fs', dir: '.receipts/store' },   // or s3, see viewer-and-sharing.md
  viewerURL: 'https://receipts.internal.example',  // links in PR comments
  repo: 'org/repo',                                // store layout; defaults to $GITHUB_REPOSITORY or the git remote
  ai: { /* off unless configured and keyed, below */ },
});
```

## baseURL and webServer

- `baseURL` is where `goto: /path` resolves. Override per run with `--base-url` or `RECEIPTS_BASE_URL`,
  or per scenario with `baseURL:` in the YAML.
- `webServer` starts your app when nothing answers `url` yet, waits up to `timeout` ms for it, and stops
  it when the run ends. With `reuseExisting: true` an app you already have running is used as is.
- Passing `--base-url` skips `webServer` entirely, which is what you want for a preview environment or
  an app you started yourself on another port.
- Every navigation is checked against `allowHosts`. Add your preview domain explicitly; Receipts refuses
  to record production-looking hosts by default.

## Test users (`personas`)

A persona is a test user. Scenarios pick one with `persona:`; `anonymous` (the default) is signed out.
Sign-in happens outside the recording, so login screens don't show up in videos, and the resulting
storageState is cached in `.receipts/personas/<name>.json` (gitignored) for `maxAgeMinutes`.

```ts
personas: {
  // 1. API sign-in: POST credentials, keep the cookies.
  learner: {
    label: 'Synthetic learner',
    signIn: { request: { method: 'POST', url: '/api/session', data: { email: process.env.E2E_EMAIL, password: process.env.E2E_PASSWORD } } },
    maxAgeMinutes: 30,
  },
  // 2. Custom function: anything Playwright can do (OAuth test endpoints, magic links, seeding).
  admin: {
    signIn: async ({ page, request, context, baseURL }) => {
      await request.post('/test/login-as', { data: { role: 'admin' } });
    },
  },
  // 3. A storageState file you captured once (SSO, MFA, or anything hard to automate).
  me: { label: 'My test account', storageState: './auth.json', ifMissing: 'skip' },
},
```

### Capturing a storageState with codegen

Open your app in Playwright's recorder, sign in by hand, then close the window. The cookies and local
storage are saved to the file:

```sh
pnpm -C /path/to/receipts/packages/core exec playwright codegen --save-storage="$PWD/auth.json" http://localhost:3000/
```

(Any `playwright` binary of a similar version works, e.g. `npx playwright codegen --save-storage=auth.json <url>`
in a project that has `@playwright/test`.)

- `ifMissing: 'skip'` (the default for storageState personas) skips scenarios using that persona when
  the file doesn't exist. The run reports them as `⏭ skipped` and doesn't fail. Use `'error'` to fail
  instead.
- **The file holds live session cookies.** Keep it out of git (add it to `.gitignore`), use a test
  account, and delete it when you're done. Receipts adds every cookie and storage value from it to the
  scrubber, so they're removed from traces and logs.
- Sessions expire. Re-run codegen when scenarios start landing on the login page.

Use test-only accounts. Receipts records whatever the account can see.

## Flag adapters

Scenarios request flag values (`flags: { new-checkout: on }`). Adapters make the app see them. Several
adapters can be listed; all are applied.

```ts
flags: {
  adapters: [
    { type: 'cookie', name: 'feature_flags', encode: 'json' },      // json | csv | (flags) => string
    { type: 'localStorage', key: 'flags' },                         // set before any page script runs
    { type: 'query', param: 'flags', encode: 'csv' },               // appended to every navigation
    { type: 'header', name: 'x-feature-flags' },                    // extra HTTP header on every request
    { type: 'route', url: '**/api/flags', transform: (body, flags) => ({ ...body, ...flags }) },  // rewrite your flags API response
    { type: 'custom', apply: async ({ context, baseURL, flags }) => {}, transformUrl: (url, flags) => url },
  ],
  // What the app actually resolved, recorded in the manifest next to what was requested.
  readResolved: (page) => page.evaluate(() => (window as any).__flags),
},
```

Pick the one your app understands:

| Your app reads flags from… | Use |
|---|---|
| a cookie or local storage the client checks | `cookie` / `localStorage` |
| a URL override (`?flags=`) | `query` |
| a request header your backend honours in dev | `header` |
| a JSON endpoint the client fetches | `route` |
| only the server, from a remote flag service, with no override | **one server per flag state** (below) |

### Pattern: one server per flag state (server-only flags)

Some apps resolve flags only on the server (from a remote flag service or env vars), with no cookie,
header or query override. You can still record both states without changing app code: run the app
twice, configured differently, and let a `custom` adapter send each scenario to the right one.

```sh
# terminal 1: flag service enabled → flag on
PORT=3100 npm run dev
# terminal 2: flag service disabled (or a different env) → flag falls back to off
PORT=3101 FLAGS_ENABLED=false npm run dev
```

```ts
const ON = 'http://localhost:3100';
const OFF = 'http://localhost:3101';

export default defineConfig({
  baseURL: ON,
  flags: {
    adapters: [{
      type: 'custom',
      apply: () => {},                                     // nothing to set in the browser
      transformUrl: (url, flags) => (flags['new-player'] === false ? url.replace(ON, OFF) : url),
    }],
    // Always confirm what the server decided, e.g. from loader data or a data attribute.
    readResolved: (page) => page.evaluate(() => ({ 'new-player': document.body.dataset.newPlayer === 'true' })),
  },
});
```

Then a scenario with a `flag-off` variant (`flags: { new-player: off }`) records against :3101. Add an
`eval` check on the resolved value so a misconfigured server fails loudly instead of recording the wrong
state. Notes:

- If you run two dev servers side by side, give each its own HMR/websocket port if your dev server
  supports it, or they'll fight over the default.
- Flag values arrive normalized: `on`/`true`/`yes` → `true`, `off`/`false`/`no` → `false`.

## Redaction

```ts
redact: {
  selectors: ['[data-testid=account-menu]', '.user-email', 'my-header-user-menu'],
  attribute: 'data-receipts-redact',     // elements with this attribute are always redacted
  style: 'blur',                         // or 'solid'
  headers: ['x-tenant-key'],             // scrubbed in addition to Authorization, Cookie, Set-Cookie, x-api-key, …
  patterns: ['acme_[a-z0-9]{24}'],       // extra secret regexes, in addition to JWTs, sk_*, ghp_*, AKIA…, Bearer, ?token=
  dropBodiesFor: ['**/api/me/profile'],  // never keep these response bodies in traces or network.json
},
```

How it's applied:

1. **In the page, before the first frame.** An init script injects CSS (`filter: blur(12px)` or solid
   fill) for the selectors, so video frames, screenshots and trace DOM snapshots never show the data.
2. **Inside shadow DOM.** The same stylesheet is added to every shadow root: roots created with
   `attachShadow` (open or closed) as they're attached, and open roots created by **declarative shadow
   DOM** (server-rendered web components) by sweeping the page each frame while loading and a few times
   a second after. Selectors match inside each root, so target the elements as they appear inside the
   component, e.g. the custom element hosting a user menu. Closed declarative roots can't be reached.
3. **Screenshots** also pass the selectors to Playwright's `mask` (which pierces open shadow roots).
4. **Traces and logs** are scrubbed: auth headers, all cookie values, persona storage values, password
   fills, matching secret patterns, and any text that was inside a redacted element are removed;
   audio/video bodies and bodies over `trace.maxBodyBytes` are dropped.

Add per-scenario selectors with `redact:` in the YAML. Check the result: open a screenshot and scrub the
video in the report before sharing it. `receipts publish` refuses bundles where the scrubber still
finds secrets.

## Embedded players and JS-expression checks

`media` steps and checks work on anything exposing the `HTMLMediaElement` surface (`currentTime`,
`paused`, `play()`, `pause()`, `muted`, media events). Native `<video>` does, and so do most
custom-element players:

```yaml
- media: { selector: mux-player, muted: true, seek: 45, play: true, waitForTime: 48 }
- expect:
    - media: { selector: mux-player, time: 48, tolerance: 3 }
```

When the selector is a custom element, `media` reads and sets properties on the element itself and
relies on the player forwarding them (and media events such as `loadedmetadata` and `seeked`) to its
internal `<video>`. `media` **checks** on `mux-player` have been verified against a real app; `media`
**steps** (seek/play/waitForTime) on custom elements haven't yet. If one times out waiting for an
event, drive the player with `eval` instead, e.g.
`eval: "document.querySelector('mux-player').currentTime = 45"`.

For anything else, use a JS-expression `eval` check. It runs in the page and passes when truthy:

```yaml
expect:
  - eval: "document.querySelector('mux-player').currentTime > 40"
  - eval: "!document.querySelector('mux-player').paused"
  - eval: "window.__player && window.__player.getCurrentTime() < 1"    # an iframe player via a test hook
```

Iframe players (YouTube, Vimeo) live in another origin. Expose a small test hook from your page (for
example `window.__player = { getCurrentTime: () => ytPlayer.getCurrentTime() }`) and check it with `eval`.

You can also read app state that drives behaviour, such as the data your framework hydrated, to confirm
the server's decision (e.g. a flag) before checking the UI.

## AI (optional, off by default)

```ts
ai: {
  provider: { type: 'openai-compatible', baseURL: 'https://api.openai.com/v1', model: 'gpt-4.1-mini', apiKeyEnv: 'RECEIPTS_AI_KEY' },
  // or a custom object: { name, judge?(req), compileStep?(req), draftScenario?(req) }
  judge: { enabled: false, canFail: false },
},
```

Used only for `judge:` checks, compiling `do:` steps once, and `plan --draft`. Nothing AI runs unless
both a provider and its key are present. The judge only sees the expectation text and redacted
screenshots, and its verdicts are labeled 🤖 and kept separate from deterministic checks.
