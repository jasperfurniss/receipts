/**
 * Playwright Test fixture used by compiled `.spec.ts` files, so committed scenarios also run under
 * plain `npx playwright test` (handy for debugging with UI mode). Evidence bundles (manifest,
 * scrubbed trace, chapters) are produced by `receipts run`; this fixture keeps behavior identical:
 * same personas, flags, redaction and chapter overlay.
 */
import { test as base, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { loadConfig, type Flags, type LoadedConfig } from './config.js';
import { FlagApplier, type FlagState } from './runner/flags.js';
import { ensurePersonaState } from './runner/personas.js';
import { installOverlay, showChapterCard, OVERLAY_ID, type ChapterState } from './runner/overlay.js';
import { installRedaction, redactionCss } from './runner/redact.js';
import { urlMatches, checkTimes } from './glob.js';
import { normalizeFlagValue } from './scenario/parse.js';

export interface ReceiptsHelpers {
  url(path: string): string;
  chapter(title: string, index: number, total: number): Promise<void>;
  setFlags(flags: Record<string, boolean | string | number>): Promise<void>;
  signIn(persona: string): Promise<void>;
  signOut(): Promise<void>;
  api(req: { method?: string; url: string; data?: unknown; headers?: Record<string, string>; expectStatus?: number }): Promise<void>;
  media(m: { selector?: string; play?: boolean; pause?: boolean; seek?: number; muted?: boolean; waitForTime?: number; timeout?: number }): Promise<void>;
  mediaTime(selector?: string): Promise<number>;
  requestCount(q: { method?: string; url: string; status?: number }): number;
  consoleErrors(): number;
  consoleWarnings(): number;
  urlMatches(pattern: string, url: string): boolean;
  capture(name: string): Promise<void>;
  judge(expectation: string): Promise<void>;
  checkTimes: typeof checkTimes;
}

let cached: Promise<LoadedConfig> | undefined;
const getConfig = () => (cached ??= loadConfig(process.env.RECEIPTS_ROOT ?? process.cwd()));

export const test = base.extend<
  { receipts: ReceiptsHelpers; receiptsPersona: string; receiptsFlags: Flags; receiptsRedact: string[] }
>({
  receiptsPersona: ['anonymous', { option: true }],
  receiptsFlags: [{}, { option: true }],
  receiptsRedact: [[], { option: true }],
  baseURL: async ({}, use) => {
    const l = await getConfig();
    await use(process.env.RECEIPTS_BASE_URL ?? l.config.baseURL);
  },
  storageState: async ({ browser, receiptsPersona, baseURL }, use) => {
    const l = await getConfig();
    await use(await ensurePersonaState(browser, l, receiptsPersona, baseURL!));
  },
  receipts: async ({ page, context, browser, baseURL, receiptsFlags, receiptsRedact }, use, testInfo) => {
    const l = await getConfig();
    const cfg = l.config;
    const state: FlagState = { current: { ...receiptsFlags } };
    const flags = new FlagApplier(cfg.flags?.adapters ?? [], state);
    let chapter: ChapterState | null = null;
    await installOverlay(context, () => chapter);
    const r = cfg.redact ?? {};
    const selectors = [...(r.selectors ?? []), ...receiptsRedact];
    const attribute = r.attribute ?? 'data-receipts-redact';
    await installRedaction(context, redactionCss(selectors, attribute, r.style ?? 'blur'));
    await flags.apply(context, baseURL!);
    const requests: { method: string; url: string; status?: number }[] = [];
    context.on('request', (q) => requests.push({ method: q.method(), url: q.url() }));
    context.on('requestfinished', async (q) => {
      const rec = [...requests].reverse().find((x) => x.url === q.url() && x.status === undefined);
      if (rec) rec.status = (await q.response())?.status();
    });
    let errors = 0;
    let warnings = 0;
    page.on('console', (m) => (m.type() === 'error' ? errors++ : m.type() === 'warning' ? warnings++ : 0));
    page.on('pageerror', () => errors++);
    const helpers: ReceiptsHelpers = {
      url: (p) => flags.transformUrl(new URL(p, baseURL).toString()),
      async chapter(title, index, total) {
        chapter = { title, index, total, key: testInfo.title };
        await showChapterCard(page, chapter, cfg.chapters?.holdMs ?? 600);
      },
      async setFlags(f) {
        for (const [k, v] of Object.entries(f)) state.current[k] = normalizeFlagValue(v);
        await flags.apply(context, baseURL!);
        if (page.url() !== 'about:blank') await page.goto(flags.transformUrl(page.url()));
      },
      async signIn(persona) {
        const file = await ensurePersonaState(browser, l, persona, baseURL!);
        await context.clearCookies();
        if (file) await context.addCookies(JSON.parse(readFileSync(file, 'utf8')).cookies ?? []);
        await flags.apply(context, baseURL!);
        if (page.url() !== 'about:blank') await page.reload();
      },
      async signOut() {
        await context.clearCookies();
        await flags.apply(context, baseURL!);
        if (page.url() !== 'about:blank') await page.reload();
      },
      async api(a) {
        const res = await context.request.fetch(new URL(a.url, baseURL).toString(), { method: a.method ?? 'GET', data: a.data as any, headers: a.headers });
        if (a.expectStatus !== undefined) expect(res.status()).toBe(a.expectStatus);
        else expect(res.status()).toBeLessThan(400);
      },
      async media(m) {
        const sel = m.selector ?? 'video';
        await page.waitForSelector(sel, { state: 'attached' });
        await page.evaluate(
          async ([s, o]) => {
            const el = document.querySelector(s) as HTMLMediaElement;
            if (o.muted !== undefined) el.muted = o.muted;
            if (el.readyState < 1) await new Promise((r) => el.addEventListener('loadedmetadata', r, { once: true }));
            if (o.seek !== undefined) {
              const d = new Promise((r) => el.addEventListener('seeked', r, { once: true }));
              el.currentTime = o.seek;
              await d;
            }
            if (o.play) await el.play().catch(async () => { el.muted = true; await el.play(); });
            if (o.pause) el.pause();
          },
          [sel, { muted: m.muted, seek: m.seek, play: m.play, pause: m.pause }] as const,
        );
        if (m.waitForTime !== undefined)
          await page.waitForFunction(([s, t]) => (document.querySelector(s) as HTMLMediaElement).currentTime >= t, [sel, m.waitForTime] as const, { timeout: m.timeout ?? 30_000 });
      },
      mediaTime: (sel = 'video') => page.evaluate((s) => (document.querySelector(s) as HTMLMediaElement | null)?.currentTime ?? -1, sel),
      requestCount: (q) =>
        requests.filter((x) => (!q.method || x.method === q.method.toUpperCase()) && urlMatches(q.url, x.url, baseURL) && (q.status === undefined || x.status === q.status)).length,
      consoleErrors: () => errors,
      consoleWarnings: () => warnings,
      urlMatches: (p, u) => urlMatches(p, u, baseURL),
      async capture(name) {
        const mask = [...selectors, `[${attribute}]`].map((s) => page.locator(s));
        const body = await page.screenshot({ mask, maskColor: '#111', style: `#${OVERLAY_ID}{display:none!important}` });
        await testInfo.attach(name, { body, contentType: 'image/png' });
      },
      async judge(expectation) {
        testInfo.annotations.push({ type: 'receipts-ai-judge', description: `skipped under playwright test: ${expectation}` });
      },
      checkTimes,
    };
    await use(helpers);
  },
});

export { expect };
