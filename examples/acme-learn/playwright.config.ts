// Optional: run the committed, compiled scenarios with plain Playwright Test (UI mode, debugging).
// Evidence bundles come from `receipts run`; this is the "eject"/debug path.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.receipts/compiled',
  testMatch: '*.spec.ts',
  workers: 1,
  reporter: 'list',
  use: { video: 'off', trace: 'retain-on-failure' },
  webServer: { command: 'node server.js', url: 'http://localhost:4173/healthz', reuseExistingServer: true },
});
