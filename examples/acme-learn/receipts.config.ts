import { defineConfig } from '@receipts/core';

export default defineConfig({
  baseURL: 'http://localhost:4173',
  // Started automatically by `receipts run` unless something already answers on /healthz.
  webServer: { command: 'node server.js', url: 'http://localhost:4173/healthz', reuseExisting: true, timeout: 20_000 },
  viewport: { width: 1280, height: 720 },
  personas: {
    // Synthetic test persona. Signs in through the API, so no login UI shows up in videos.
    learner: {
      label: 'Ada (synthetic learner)',
      signIn: {
        request: {
          method: 'POST',
          url: '/api/session',
          data: { email: process.env.ACME_LEARNER_EMAIL ?? 'ada@acme.test', password: process.env.ACME_LEARNER_PASSWORD ?? 'correct-horse' },
        },
      },
      maxAgeMinutes: 0, // the demo keeps sessions in memory, so always sign in fresh
    },
  },
  flags: {
    adapters: [{ type: 'cookie', name: 'acme_flags', encode: 'json' }],
    readResolved: (page) => page.evaluate(() => (window as any).__acmeFlags),
  },
  redact: {
    selectors: ['[data-testid=account-menu]', '.learner-email'],
    style: 'blur',
    dropBodiesFor: ['**/api/me/profile'],
  },
  store: { type: 'fs', dir: '.receipts/store' },
  viewerURL: 'http://localhost:4400',
  repo: 'acme/acme-learn',
  // ai: { provider: { type: 'openai-compatible', model: 'gpt-4.1-mini', apiKeyEnv: 'RECEIPTS_AI_KEY' }, judge: { enabled: true } },
});
