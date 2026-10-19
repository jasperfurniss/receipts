#!/usr/bin/env node
import { loadConfig, createStore } from '@receipts/core';
import { createViewer } from './server.js';
import type { AuthConfig } from './auth.js';

const env = process.env;
const loaded = await loadConfig(process.cwd());
const store = createStore(loaded.config.store ?? { type: 'fs', dir: '.receipts/store' }, loaded.root);
const mode = (env.RECEIPTS_VIEWER_AUTH ?? (env.RECEIPTS_VIEWER_TOKEN ? 'token' : 'none')) as AuthConfig['mode'];
const host = env.HOST ?? '127.0.0.1';
const port = Number(env.PORT ?? 4400);
const auth: AuthConfig =
  mode === 'token'
    ? { mode, token: env.RECEIPTS_VIEWER_TOKEN ?? '' }
    : mode === 'header'
      ? { mode, allowedDomains: env.RECEIPTS_ALLOWED_DOMAINS?.split(','), allowedGroups: env.RECEIPTS_ALLOWED_GROUPS?.split(','), trustedProxies: env.RECEIPTS_TRUSTED_PROXIES?.split(',') }
      : { mode: 'none' };
if (auth.mode === 'none' && !['127.0.0.1', 'localhost', '::1'].includes(host)) {
  console.error('Refusing to serve without auth on a non-loopback interface. Set RECEIPTS_VIEWER_TOKEN or RECEIPTS_VIEWER_AUTH=header.');
  process.exit(1);
}
if (auth.mode === 'token' && auth.token.length < 16) {
  console.error('RECEIPTS_VIEWER_TOKEN must be at least 16 characters.');
  process.exit(1);
}
createViewer({ store, auth, auditLog: env.RECEIPTS_AUDIT_LOG }).listen(port, host, () => console.log(`Receipts viewer on http://${host}:${port} (auth: ${auth.mode})`));
