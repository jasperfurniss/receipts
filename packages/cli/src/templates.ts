export const CONFIG_TEMPLATE = `import { defineConfig } from '@receipts/core';

export default defineConfig({
  baseURL: 'http://localhost:3000',
  // Start the app if nothing answers yet (or pass --base-url to target a preview env).
  webServer: { command: 'npm run dev', url: 'http://localhost:3000/healthz', reuseExisting: true, timeout: 120_000 },
  viewport: { width: 1280, height: 720 },
  personas: {
    learner: {
      label: 'Synthetic test user',
      // API sign-in keeps login screens out of videos. Use test-only credentials.
      signIn: { request: { method: 'POST', url: '/api/session', data: { email: process.env.RECEIPTS_USER_EMAIL, password: process.env.RECEIPTS_USER_PASSWORD } } },
    },
  },
  flags: {
    // Pick what your app understands: cookie | localStorage | query | header | route | custom
    adapters: [{ type: 'cookie', name: 'feature_flags', encode: 'json' }],
    // readResolved: (page) => page.evaluate(() => (window as any).__flags),
  },
  redact: {
    selectors: ['[data-testid=account-menu]', '.user-email', '[data-testid=avatar]'],
    style: 'blur',
  },
  store: { type: 'fs', dir: '.receipts/store' },
  // store: { type: 's3', bucket: 'my-receipts', region: 'us-east-1', prefix: 'evidence' },
  // viewerURL: 'https://receipts.internal.example',
  // ai: { provider: { type: 'openai-compatible', model: 'gpt-4.1-mini', apiKeyEnv: 'RECEIPTS_AI_KEY' }, judge: { enabled: false } },
});
`;

export const SCENARIO_TEMPLATE = (id: string, title: string) => `id: ${id}
title: ${title}
tags: []
covers:                 # paste the PR Test Plan checkbox text this proves
  - "${title}"
persona: anonymous      # or a persona from receipts.config.ts
flags: {}
steps:
  - chapter: Open the page
    goto: /
    expect:
      - visible: { role: main }
    capture: start

  - chapter: Health
    expect:
      - console: { errors: 0 }
`;

export const WORKFLOW_TEMPLATE = `name: receipts
on:
  pull_request:            # never pull_request_target: fork PRs get no secrets
    types: [opened, synchronize, reopened, edited]
permissions:
  contents: read
  pull-requests: write
  checks: write
  id-token: write          # OIDC for the artifact bucket, if you use one
concurrency:
  group: receipts-\${{ github.event.pull_request.number }}
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
      # - uses: aws-actions/configure-aws-credentials@v4   # OIDC → write-only role scoped to pr-<n>/
      #   with: { role-to-assume: arn:aws:iam::123456789012:role/receipts-writer, aws-region: us-east-1 }
      - uses: ./node_modules/@receipts/action   # or your-org/receipts-action@v1
        with:
          dry-run: 'false'
`;
