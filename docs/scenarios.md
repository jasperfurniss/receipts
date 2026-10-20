# Scenarios

Scenarios live in `.receipts/scenarios/*.yml`. One file holds one scenario plus its **variants**. Each
variant runs as its own scenario with its own video, screenshots, trace and verdicts.

## Shape

```yaml
id: video-resume                       # slug; variants become video-resume/<variant-id>
title: Lesson video resumes from saved progress
description: Optional longer text, shown in the report.
tags: [smoke, video]                   # select with @smoke
covers:                                # Test Plan checkbox text this proves (fuzzy-matched by `plan` and CI)
  - "Signed-in learner: watch ~40s, leave, return"
persona: learner                       # a test user from receipts.config.ts; `anonymous` = signed out (default)
flags: { resume-playback: "on" }       # on/off/true/false/yes/no become booleans; anything else stays a string
viewport: { width: 1280, height: 720 }
baseURL: http://localhost:4173         # optional per-scenario override
fixtures: { lesson: intro-to-typography }   # {{lesson}} anywhere in strings; {{env.NAME}} reads env vars
setup:                                 # runs before recording chapters (not in the timeline)
  - id: reset
    api: { method: DELETE, url: "/api/me/progress/lessons/{{lesson}}" }
steps: [ … ]
variants: [ … ]
redact: [".avatar"]                    # extra redaction selectors for this scenario only
```

> YAML gotcha: quote values containing `{{…}}` inside `{ … }` flow maps.

## Steps

A step can combine keys. Within one step they run in this order:
**navigation (`goto`/`reload`/`back`) → `flag`/`signIn`/`signOut` → `api` → interactions → `eval` →
`media` → `do` → `sleep` → `wait` → `expect` → `capture`**.
When you need a different order (for example *reload, wait for data, then click*), split it into steps.

| Key | Example |
|---|---|
| `id` | `id: open` (needed for variant overrides and `skip_steps`) |
| `chapter` | `chapter: Return to the lesson`: the title card in the video and the step name everywhere |
| `goto`, `reload`, `back` | `goto: /courses` (relative to baseURL; host allowlist enforced) · `reload: true` · `back: true` |
| `click`, `dblclick`, `hover`, `check`, `uncheck` | `click: { role: button, name: Play }` |
| `fill` | `fill: { target: { label: Email }, value: "{{email}}" }`; password-ish fields are scrubbed from traces |
| `press`, `select` | `press: Enter` · `press: { target: "#q", key: Enter }` · `select: { target: "#plan", value: pro }` |
| `flag` | `flag: { resume-playback: off }` re-applies adapters and reloads |
| `signIn`, `signOut` | `signIn: learner` · `signOut: true` |
| `api` | `api: { method: PUT, url: /api/x, data: {…}, expectStatus: 200 }` (shares the page's cookies) |
| `eval` / `evaluate` | `eval: "window.scrollTo(0, 0)"` |
| `media` | `media: { selector: video, muted: true, seek: 40, play: true, waitForTime: 42 }` · `{ pause: true }` |
| `sleep` | `sleep: 500` (ms) |
| `wait` / `waitFor` | `{ selector: video, state: attached }` · `{ url: "**/done" }` · `{ load: networkidle }` · `{ request: "**/api/x", method: PUT }` · `1000` |
| `do` | Natural language, compiled once (AI, or by hand with `receipts steps:add`) and cached in `.receipts/compiled/steps.json` |
| `capture` / `screenshot` | `capture: resumed` · `{ name: full, fullPage: true }`: redacted screenshot after the step |

**Targets** are a Playwright selector string, or `{ role, name, exact }`, `{ text }`, `{ label }`,
`{ testId }`, `{ placeholder }`, `{ selector }`. `name`, `text` and `label` accept `/regex/flags`.

## Checks (`expect:`)

Each check polls until it passes or times out (`expectTimeout`, default 5 s, or its own `timeout`).

| Check | Example |
|---|---|
| `visible` / `hidden` | `visible: { text: "/Resuming from 0:4\\d/" }` |
| `text` | `text: { target: h1, contains: "Typography" }` · `equals` · `matches: "/re/"` |
| `url`, `title` | `url: "**/courses"` · `title: "/Acme/"` |
| `eval` | `eval: "document.querySelector('video').currentTime < 1"`: passes when truthy |
| `request` | `request: { method: PUT, url: "/api/me/progress/**", times: ">=1", status: 200 }`: counts since the scenario started; `0` / `<n` wait 750 ms first |
| `console` | `console: { errors: 0, warnings: 2 }`: uncaught page errors count as errors |
| `media` | `media: { time: 42, tolerance: 3 }` · `{ gte: 10, lte: 20 }` · `{ paused: true }`; `selector:` defaults to `video` |
| `judge` | `judge: "Shows a 'Resuming from' note near 0:42"`: 🤖 AI-judged, off by default, reported separately, never fails a run unless `ai.judge.canFail` |

## Variants

A variant starts from the base scenario and changes only what you specify:

| Key | Effect |
|---|---|
| `id`, `title`, `covers`, `tags` | identity; `covers` adds Test Plan items |
| `persona` | replaces the base test user |
| `flags`, `fixtures` | merged over the base values |
| `skip_steps: [reset]` | drops steps or setup steps by id |
| `override_steps: { open: { chapter: …, expect: [ … ] } }` | patches steps by id; `expect` replaces, other keys merge |
| `override_last_expect: [ … ]` | replaces the `expect` of the last step that has non-console checks |

## Example: signed-in resume with flag-off and signed-out variants

Adapted from `examples/acme-learn/.receipts/scenarios/video-resume.yml`:

```yaml
id: video-resume
title: Lesson video resumes from saved progress
tags: [smoke, video, progress]
covers:
  - "Signed-in learner: watch ~40s, leave, return"
  - "No console errors on the lesson page"
persona: learner
flags:
  resume-playback: on
fixtures:
  lesson: intro-to-typography
setup:
  - id: reset
    api: { method: DELETE, url: "/api/me/progress/lessons/{{lesson}}" }

steps:
  - id: open
    chapter: Open lesson as signed-in learner
    goto: /lessons/{{lesson}}
    expect:
      - visible: { role: region, name: Lesson video }
      - media: { lte: 1 }
    capture: opened

  - id: watch
    chapter: Watch ~40 seconds
    media: { muted: true, seek: 40, play: true, waitForTime: 42 }
    capture: playing-at-40s
    expect:
      - request: { method: PUT, url: "/api/me/progress/**", times: ">=1" }

  - id: leave
    chapter: Leave the lesson
    goto: /courses

  - id: return
    chapter: Return to the lesson
    goto: /lessons/{{lesson}}
    wait: { selector: video, state: attached }
    expect:
      - media: { time: 42, tolerance: 3 }
      - visible: { text: "/Resuming from 0:4\\d/" }
    capture: resumed

  - id: health
    chapter: Health
    expect:
      - console: { errors: 0 }

variants:
  - id: flag-off
    covers: ["Flag off → video starts at 0:00"]
    flags: { resume-playback: off }
    override_last_expect:
      - media: { lte: 1 }
      - hidden: { text: "/Resuming from/" }

  - id: signed-out
    covers: ["Signed out → video starts at 0:00, no progress API calls"]
    persona: anonymous
    skip_steps: [reset]
    override_steps:
      watch:
        expect: []
    override_last_expect:
      - media: { lte: 1 }
      - request: { url: "/api/me/progress/**", times: 0 }
```

## Example: an embedded custom-element player

Players built as custom elements (for example `<mux-player>`) expose `currentTime`, `paused` and
`play()` on the element, so `media` steps and checks can target them with `selector:`. Start playback
with the page's own poster or play button so the app's logic (such as resuming) actually runs:

```yaml
steps:
  - id: open
    chapter: Open the article
    goto: /articles/some-article/
    wait: { selector: ".video-poster", state: visible }

  - id: play
    chapter: Play the embedded video
    click: ".video-poster"
    sleep: 4000
    expect:
      - media: { selector: mux-player, gte: 0.5, lte: 8, paused: false }
      - eval: "document.querySelector('mux-player').currentTime < 8"
```

Iframe players (YouTube, Vimeo) need a test hook; see
[config.md → embedded players](config.md#embedded-players-and-js-expression-checks).

## Test Plan mapping

`receipts plan --body-file pr-body.md` (or `--pr <n>`, which uses the `gh` CLI) reads the
`## Test Plan` checkboxes and fuzzy-matches them against every scenario's and variant's `covers:`.
Unmatched items stay `manual`. `--draft` writes skeleton scenarios for them to
`.receipts/scenarios/drafts/`.
