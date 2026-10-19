import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Browser } from 'playwright';
import type { LoadedConfig } from '../config.js';

export const ANONYMOUS = 'anonymous';

/**
 * Sign in a persona once (via API or a custom function, never through the recorded UI) and cache
 * its storageState under `.receipts/personas/<name>.json`.
 */
export async function ensurePersonaState(browser: Browser, loaded: LoadedConfig, name: string, baseURL: string, force = false): Promise<string | undefined> {
  if (name === ANONYMOUS) return undefined;
  const p = loaded.config.personas?.[name];
  if (!p) throw new Error(`unknown persona "${name}" (define it in receipts.config.ts → personas)`);
  if (p.storageState) return resolve(loaded.root, p.storageState);
  if (!p.signIn) throw new Error(`persona "${name}" needs storageState or signIn`);
  const dir = join(loaded.outDir, 'personas');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name}.json`);
  const maxAge = (p.maxAgeMinutes ?? 30) * 60_000;
  if (!force && existsSync(file) && Date.now() - statSync(file).mtimeMs < maxAge) return file;
  const context = await browser.newContext({ baseURL });
  try {
    if (typeof p.signIn === 'function') {
      const page = await context.newPage();
      await p.signIn({ context, page, request: context.request, baseURL, persona: name });
    } else {
      const r = p.signIn.request;
      const res = await context.request.fetch(new URL(r.url, baseURL).toString(), {
        method: r.method ?? 'POST',
        data: r.data as any,
        headers: r.headers,
      });
      if (!res.ok()) throw new Error(`persona "${name}" sign-in failed: ${res.status()} ${await res.text().catch(() => '')}`.slice(0, 300));
    }
    await context.storageState({ path: file });
  } finally {
    await context.close();
  }
  return file;
}
