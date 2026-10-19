import type { Page } from 'playwright';
import type { Assertion } from '../scenario/schema.js';
import type { AssertionResult } from '../manifest.js';
import { checkTimes, parseRegexLiteral, urlMatches } from '../glob.js';
import { describeTarget, locate } from './locate.js';

export interface RequestRecord {
  method: string;
  url: string;
  status?: number;
  failed?: string;
  resourceType: string;
  ts: number;
  step: number;
}

export interface AssertCtx {
  page: Page;
  baseURL: string;
  timeout: number;
  requests: RequestRecord[];
  consoleCounts: () => { errors: number; warnings: number };
  /** AI judge hook. Returns undefined when the judge is disabled. */
  judge?: (expectation: string) => Promise<Omit<AssertionResult, 'kind' | 'description'> | undefined>;
}

async function poll<T>(timeout: number, probe: () => Promise<T>, ok: (v: T) => boolean): Promise<{ value: T; pass: boolean }> {
  const end = Date.now() + timeout;
  let value = await probe();
  while (!ok(value) && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 150));
    value = await probe();
  }
  return { value, pass: ok(value) };
}

const fmt = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));
const short = (s: string, n = 160) => (s.length > n ? s.slice(0, n) + '…' : s);

export function describeAssertion(a: Assertion): { kind: string; description: string } {
  if ('visible' in a) return { kind: 'visible', description: `${describeTarget(a.visible)} is visible` };
  if ('hidden' in a) return { kind: 'hidden', description: `${describeTarget(a.hidden)} is hidden` };
  if ('text' in a) {
    const t = a.text;
    const op = t.equals !== undefined ? `equals "${t.equals}"` : t.matches !== undefined ? `matches ${t.matches}` : `contains "${t.contains}"`;
    return { kind: 'text', description: `text of ${t.target ? describeTarget(t.target) : 'page'} ${op}` };
  }
  if ('url' in a) return { kind: 'url', description: `URL matches ${a.url}` };
  if ('title' in a) return { kind: 'title', description: `title matches ${a.title}` };
  if ('eval' in a) return { kind: 'eval', description: a.eval };
  if ('request' in a) {
    const r = a.request;
    return { kind: 'request', description: `${r.method ?? 'any'} ${r.url} called ${r.times ?? '>=1'} time(s)${r.status ? ` with ${r.status}` : ''}` };
  }
  if ('console' in a) {
    const parts = [];
    if (a.console.errors !== undefined) parts.push(`${a.console.errors} console errors`);
    if (a.console.warnings !== undefined) parts.push(`${a.console.warnings} warnings`);
    return { kind: 'console', description: parts.join(', ') || 'console' };
  }
  if ('media' in a) {
    const m = a.media;
    const sel = m.selector ?? 'video';
    const parts: string[] = [];
    if (m.time !== undefined) parts.push(`currentTime ≈ ${m.time} ± ${m.tolerance ?? 1}s`);
    if (m.gte !== undefined) parts.push(`currentTime ≥ ${m.gte}`);
    if (m.lte !== undefined) parts.push(`currentTime ≤ ${m.lte}`);
    if (m.paused !== undefined) parts.push(m.paused ? 'paused' : 'playing');
    return { kind: 'media', description: `${sel} ${parts.join(', ')}` };
  }
  return { kind: 'judge', description: a.judge };
}

export async function runAssertion(a: Assertion, ctx: AssertCtx): Promise<AssertionResult> {
  const { kind, description } = describeAssertion(a);
  const t0 = Date.now();
  const timeout = ('timeout' in a && typeof a.timeout === 'number' ? a.timeout : undefined) ?? ctx.timeout;
  const base = { kind, description, aiJudged: false };
  try {
    const r = await evaluate(a, ctx, timeout);
    return { ...base, ...r, durationMs: Date.now() - t0 };
  } catch (e) {
    return { ...base, status: 'failed', error: short((e as Error).message, 400), durationMs: Date.now() - t0 };
  }
}

async function evaluate(a: Assertion, ctx: AssertCtx, timeout: number): Promise<Omit<AssertionResult, 'kind' | 'description' | 'aiJudged'> & { aiJudged?: boolean }> {
  const { page } = ctx;
  if ('visible' in a || 'hidden' in a) {
    const want = 'visible' in a;
    const loc = locate(page, 'visible' in a ? a.visible : a.hidden);
    const { value, pass } = await poll(
      timeout,
      async () => {
        const n = await loc.count();
        if (n === 0) return 'not found';
        return (await loc.first().isVisible()) ? 'visible' : 'hidden';
      },
      (v) => (want ? v === 'visible' : v !== 'visible'),
    );
    return { status: pass ? 'passed' : 'failed', expected: want ? 'visible' : 'hidden', actual: value };
  }
  if ('text' in a) {
    const t = a.text;
    const loc = t.target ? locate(page, t.target).first() : page.locator('body');
    const re = t.matches !== undefined ? parseRegexLiteral(t.matches) ?? new RegExp(t.matches) : undefined;
    const { value, pass } = await poll(
      timeout,
      async () => ((await loc.count()) ? (await loc.innerText()).trim() : '(element not found)'),
      (v) => (t.equals !== undefined ? v === t.equals : re ? re.test(v) : v.includes(t.contains ?? '')),
    );
    const matched = re ? re.exec(value)?.[0] : undefined;
    return { status: pass ? 'passed' : 'failed', expected: t.equals ?? t.matches ?? t.contains, actual: short(matched ?? value) };
  }
  if ('url' in a) {
    const { value, pass } = await poll(timeout, async () => page.url(), (u) => urlMatches(a.url, u, ctx.baseURL));
    return { status: pass ? 'passed' : 'failed', expected: a.url, actual: value };
  }
  if ('title' in a) {
    const re = parseRegexLiteral(a.title);
    const { value, pass } = await poll(timeout, () => page.title(), (v) => (re ? re.test(v) : v === a.title));
    return { status: pass ? 'passed' : 'failed', expected: a.title, actual: value };
  }
  if ('eval' in a) {
    const { value, pass } = await poll(
      timeout,
      async () => {
        try {
          return { v: await page.evaluate(a.eval) };
        } catch (e) {
          return { err: (e as Error).message.split('\n')[0] };
        }
      },
      (r) => 'v' in r && !!r.v,
    );
    return { status: pass ? 'passed' : 'failed', expected: 'truthy', actual: 'err' in value ? `error: ${value.err}` : fmt(value.v) };
  }
  if ('request' in a) {
    const r = a.request;
    const count = () =>
      ctx.requests.filter(
        (q) =>
          (!r.method || q.method.toUpperCase() === r.method.toUpperCase()) &&
          urlMatches(r.url, q.url, ctx.baseURL) &&
          (r.status === undefined || q.status === r.status),
      ).length;
    const spec = r.times;
    const upperBound = spec === 0 || (typeof spec === 'string' && /^(<|<=|==|=|\d)/.test(spec.trim()));
    let n: number;
    let pass: boolean;
    if (upperBound) {
      // Can't prove a negative by polling; let in-flight requests land, then count once.
      await page.waitForTimeout(Math.min(750, timeout));
      n = count();
      pass = checkTimes(spec, n);
    } else {
      const res = await poll(timeout, async () => count(), (v) => checkTimes(spec, v));
      n = res.value;
      pass = res.pass;
    }
    return { status: pass ? 'passed' : 'failed', expected: String(spec ?? '>=1'), actual: `${n} matching request(s)` };
  }
  if ('console' in a) {
    await page.waitForTimeout(250);
    const c = ctx.consoleCounts();
    const pass = (a.console.errors === undefined || c.errors <= a.console.errors) && (a.console.warnings === undefined || c.warnings <= a.console.warnings);
    return {
      status: pass ? 'passed' : 'failed',
      expected: `errors ≤ ${a.console.errors ?? '∞'}${a.console.warnings !== undefined ? `, warnings ≤ ${a.console.warnings}` : ''}`,
      actual: `${c.errors} error(s), ${c.warnings} warning(s)`,
    };
  }
  if ('media' in a) {
    const m = a.media;
    const sel = m.selector ?? 'video';
    const { value, pass } = await poll(
      timeout,
      () =>
        page.evaluate((s) => {
          const el = document.querySelector(s) as HTMLMediaElement | null;
          return el ? { t: el.currentTime, paused: el.paused, ready: el.readyState } : null;
        }, sel),
      (v) =>
        !!v &&
        (m.time === undefined || Math.abs(v.t - m.time) <= (m.tolerance ?? 1)) &&
        (m.gte === undefined || v.t >= m.gte) &&
        (m.lte === undefined || v.t <= m.lte) &&
        (m.paused === undefined || v.paused === m.paused),
    );
    const exp = describeAssertion(a).description.replace(`${sel} `, '');
    return {
      status: pass ? 'passed' : 'failed',
      expected: exp,
      actual: value ? `currentTime ${value.t.toFixed(1)}s${value.paused ? ' (paused)' : ' (playing)'}` : `no ${sel} element`,
    };
  }
  // judge
  const res = ctx.judge ? await ctx.judge(a.judge) : undefined;
  if (!res) return { status: 'skipped', aiJudged: true, rationale: 'AI judge disabled (enable ai.judge and configure a provider key)' };
  return { ...res, aiJudged: true };
}
