import { mkdir, rename, rm, writeFile, copyFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import os from 'node:os';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { LoadedConfig } from '../config.js';
import type { ResolvedScenario, Step } from '../scenario/schema.js';
import { gitInfo, type GitInfo } from '../git.js';
import { DEFAULT_ALLOW_HOSTS, hostAllowed, urlMatches } from '../glob.js';
import { Scrubber, scanForSecrets, scrubTraceZip } from '../scrub.js';
import {
  artifactRecord,
  countVerdicts,
  sealManifest,
  scenarioDirName,
  type ArtifactRecord,
  type AssertionResult,
  type Manifest,
  type RunSummary,
  type StepResult,
} from '../manifest.js';
import { hasFfmpeg, webmToMp4 } from '../media.js';
import { judgeEnabled } from '../judge.js';
import { readStepCache, stepHash } from '../compile/cache.js';
import { compiledHashFor } from '../compile/compiler.js';
import { describeTarget, locate } from './locate.js';
import { callout, installOverlay, showChapterCard, OVERLAY_ID, type ChapterState } from './overlay.js';
import { collectRedactedText, installRedaction, redactionCss } from './redact.js';
import { FlagApplier, type FlagState } from './flags.js';
import { ANONYMOUS, ensurePersonaState } from './personas.js';
import { runAssertion, type RequestRecord } from './assertions.js';
import { startWebServer } from './webserver.js';

export interface RunOptions {
  headed?: boolean;
  baseURL?: string;
  runId?: string;
  /** Re-sign-in personas even if cached. */
  freshPersonas?: boolean;
  log?: (s: string) => void;
}

export function newRunId(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const rand = Math.random().toString(36).slice(2, 6);
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${rand}`;
}

const PW_VERSION = (() => {
  try {
    const u = new URL('../../node_modules/playwright/package.json', import.meta.url);
    return JSON.parse(readFileSync(u, 'utf8')).version as string;
  } catch {
    return 'unknown';
  }
})();

export function stepAction(step: Step): string {
  const keys = ['goto', 'reload', 'back', 'click', 'dblclick', 'hover', 'fill', 'press', 'select', 'check', 'uncheck', 'flag', 'signIn', 'signOut', 'api', 'eval', 'evaluate', 'media', 'do', 'sleep', 'wait', 'waitFor'] as const;
  const k = keys.find((k) => (step as any)[k] !== undefined);
  if (!k) return step.expect ? 'expect' : step.capture || step.screenshot ? 'capture' : 'noop';
  return k;
}

export function stepTitle(step: Step): string {
  if (step.chapter) return step.chapter;
  if (step.goto) return `Go to ${step.goto}`;
  if (step.click) return `Click ${describeTarget(step.click)}`;
  if (step.fill) return `Fill ${describeTarget(step.fill.target)}`;
  if (step.do) return step.do;
  if (step.flag) return `Set flags ${Object.entries(step.flag).map(([k, v]) => `${k}=${v}`).join(', ')}`;
  if (step.signIn) return `Sign in as ${step.signIn}`;
  if (step.signOut) return 'Sign out';
  if (step.api) return `${step.api.method} ${step.api.url}`;
  if (step.media) return 'Media control';
  if (step.expect) return 'Check';
  return stepAction(step);
}

interface Live {
  scenario: ResolvedScenario;
  loaded: LoadedConfig;
  baseURL: string;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  flags: FlagApplier;
  flagState: FlagState;
  scrubber: Scrubber;
  requests: RequestRecord[];
  consoleLog: { type: string; text: string; location?: string; ts: number; step: number }[];
  currentStep: number;
  personaFiles: Map<string, string | undefined>;
  freshPersonas: boolean;
}

const OVERLAY_HIDE_CSS = `#${OVERLAY_ID}{display:none!important}`;

async function ensurePersona(live: Live, name: string) {
  if (!live.personaFiles.has(name)) live.personaFiles.set(name, await ensurePersonaState(live.browser, live.loaded, name, live.baseURL, live.freshPersonas));
  return live.personaFiles.get(name);
}

function resolveUrl(live: Live, target: string): string {
  const url = new URL(target, live.baseURL).toString();
  const allow = live.loaded.config.allowHosts ?? DEFAULT_ALLOW_HOSTS;
  if (!hostAllowed(url, allow)) throw new Error(`refusing to navigate to ${new URL(url).host}: not in allowHosts (${allow.join(', ')})`);
  return live.flags.transformUrl(url);
}

async function runAction(live: Live, step: Step): Promise<void> {
  const { page, context } = live;
  const actionTimeout = live.loaded.config.actionTimeout ?? 10_000;
  const act = async (t: Parameters<typeof locate>[1], fn: (l: ReturnType<typeof locate>) => Promise<unknown>) => {
    const l = locate(page, t);
    await callout(l.first());
    await fn(l);
  };
  if (step.goto) await page.goto(resolveUrl(live, step.goto), { waitUntil: 'load', timeout: 30_000 });
  if (step.reload) await page.reload({ waitUntil: 'load' });
  if (step.back) await page.goBack({ waitUntil: 'load' });
  if (step.flag) {
    live.flagState.current = { ...live.flagState.current };
    for (const [k, v] of Object.entries(step.flag)) {
      const { normalizeFlagValue } = await import('../scenario/parse.js');
      live.flagState.current[k] = normalizeFlagValue(v);
    }
    await live.flags.apply(context, live.baseURL);
    if (page.url() !== 'about:blank') await page.goto(live.flags.transformUrl(page.url()), { waitUntil: 'load' });
  }
  if (step.signOut) {
    await context.clearCookies();
    await live.flags.apply(context, live.baseURL); // keep flag cookies
    if (page.url() !== 'about:blank') await page.reload({ waitUntil: 'load' });
  }
  if (step.signIn) {
    const file = await ensurePersona(live, step.signIn);
    await context.clearCookies();
    if (file) {
      const state = JSON.parse(readFileSync(file, 'utf8'));
      await context.addCookies(state.cookies ?? []);
      live.scrubber.addLiterals((state.cookies ?? []).map((c: any) => c.value));
    }
    await live.flags.apply(context, live.baseURL);
    if (page.url() !== 'about:blank') await page.reload({ waitUntil: 'load' });
  }
  if (step.api) {
    const a = step.api;
    const res = await context.request.fetch(resolveUrl(live, a.url), { method: a.method, data: a.data as any, headers: a.headers, failOnStatusCode: false });
    const ok = a.expectStatus !== undefined ? res.status() === a.expectStatus : res.status() < 400;
    if (!ok) throw new Error(`api ${a.method} ${a.url} → ${res.status()}${a.expectStatus !== undefined ? ` (expected ${a.expectStatus})` : ''}`);
  }
  if (step.click) await act(step.click, (l) => l.click({ timeout: actionTimeout }));
  if (step.dblclick) await act(step.dblclick, (l) => l.dblclick({ timeout: actionTimeout }));
  if (step.hover) await act(step.hover, (l) => l.hover({ timeout: actionTimeout }));
  if (step.fill) {
    // Values typed into password-ish fields are treated as secrets in traces and logs.
    if (/pass(word)?|secret|token|otp|pin/i.test(JSON.stringify(step.fill.target))) live.scrubber.addLiterals([step.fill.value]);
    await act(step.fill.target, (l) => l.fill(step.fill!.value, { timeout: actionTimeout }));
  }
  if (step.select) await act(step.select.target, (l) => l.selectOption(step.select!.value, { timeout: actionTimeout }));
  if (step.check) await act(step.check, (l) => l.check({ timeout: actionTimeout }));
  if (step.uncheck) await act(step.uncheck, (l) => l.uncheck({ timeout: actionTimeout }));
  if (step.press) {
    if (typeof step.press === 'string') await page.keyboard.press(step.press);
    else if (step.press.target) await locate(page, step.press.target).press(step.press.key, { timeout: actionTimeout });
    else await page.keyboard.press(step.press.key);
  }
  const code = step.eval ?? step.evaluate;
  if (code) {
    const body = /\breturn\b|;|\n/.test(code.trim()) ? `(async () => { ${code} })()` : code;
    await page.evaluate(body);
  }
  if (step.media) await mediaAction(page, step.media);
  if (step.do) await runCompiledStep(live, step.do);
  if (step.sleep) await page.waitForTimeout(step.sleep);
  const w = step.wait ?? step.waitFor;
  if (w !== undefined) {
    if (typeof w === 'number') await page.waitForTimeout(w);
    else if ('ms' in w) await page.waitForTimeout(w.ms);
    else if ('selector' in w) await page.waitForSelector(w.selector, { state: w.state ?? 'visible', timeout: w.timeout ?? actionTimeout });
    else if ('url' in w) await page.waitForURL((u) => urlMatches(w.url, u.toString(), live.baseURL), { timeout: w.timeout ?? actionTimeout });
    else if ('load' in w) await page.waitForLoadState(w.load);
    else if ('request' in w)
      await page.waitForRequest((r) => urlMatches(w.request, r.url(), live.baseURL) && (!w.method || r.method() === w.method.toUpperCase()), { timeout: w.timeout ?? actionTimeout });
  }
}

async function mediaAction(page: Page, m: NonNullable<Step['media']>) {
  const sel = m.selector ?? 'video';
  await page.waitForSelector(sel, { state: 'attached', timeout: m.timeout ?? 10_000 });
  await page.evaluate(
    async ([s, opts]) => {
      const el = document.querySelector(s) as HTMLMediaElement;
      if (opts.muted !== undefined) el.muted = opts.muted;
      if (el.readyState < 1) await new Promise((r) => el.addEventListener('loadedmetadata', r, { once: true }));
      if (opts.seek !== undefined) {
        const done = new Promise((r) => el.addEventListener('seeked', r, { once: true }));
        el.currentTime = opts.seek;
        await done;
      }
      if (opts.play) {
        try {
          await el.play();
        } catch {
          el.muted = true; // autoplay policy: retry muted
          await el.play();
        }
      }
      if (opts.pause) el.pause();
    },
    [sel, { muted: m.muted, seek: m.seek, play: m.play, pause: m.pause }] as const,
  );
  if (m.waitForTime !== undefined)
    await page.waitForFunction(([s, t]) => ((document.querySelector(s) as HTMLMediaElement)?.currentTime ?? 0) >= t, [sel, m.waitForTime] as const, {
      timeout: m.timeout ?? Math.max(15_000, m.waitForTime * 1000 * 2),
      polling: 100,
    });
}

async function runCompiledStep(live: Live, instruction: string) {
  const cache = readStepCache(live.loaded.compiledDir);
  const entry = cache[stepHash(instruction)];
  if (!entry)
    throw new Error(
      `natural-language step not compiled: "${instruction}". Run \`receipts compile\` with an AI provider configured, ` +
        `or add code for hash ${stepHash(instruction)} to ${relative(live.loaded.root, join(live.loaded.compiledDir, 'steps.json'))}.`,
    );
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...a: string[]) => (...args: unknown[]) => Promise<void>;
  const fn = new AsyncFunction('page', 'context', entry.code);
  await fn(live.page, live.context);
}

function judgeHook(live: Live, step: StepResult) {
  const provider = judgeEnabled(live.loaded.config.ai);
  if (!provider) return undefined;
  const canFail = !!live.loaded.config.ai?.judge?.canFail;
  return async (expectation: string) => {
    const { mask } = maskLocators(live);
    const img = await live.page.screenshot({ mask, maskColor: '#111', style: OVERLAY_HIDE_CSS });
    const v = await provider.judge!({ expectation, images: [img], context: { url: live.page.url(), scenario: live.scenario.key, step: step.chapter } });
    const status: AssertionResult['status'] = v.verdict === 'pass' ? 'passed' : v.verdict === 'fail' ? (canFail ? 'failed' : 'warn') : 'unsure';
    return { status, aiJudged: true, rationale: v.rationale, confidence: v.confidence, expected: expectation, actual: `${v.verdict} (${provider.name})` };
  };
}

function redactSelectors(live: Live) {
  const r = live.loaded.config.redact ?? {};
  return { selectors: [...(r.selectors ?? []), ...live.scenario.redact], attribute: r.attribute ?? 'data-receipts-redact', style: r.style ?? 'blur' };
}
function maskLocators(live: Live) {
  const { selectors, attribute } = redactSelectors(live);
  return { mask: [...selectors, `[${attribute}]`].map((s) => live.page.locator(s)) };
}

export interface ScenarioRunResult {
  manifest: Manifest;
  dir: string;
}

async function runOne(
  browser: Browser,
  loaded: LoadedConfig,
  scenario: ResolvedScenario,
  runDir: string,
  runId: string,
  git: GitInfo,
  opts: RunOptions & { baseURL: string; headless: boolean; personaFiles: Map<string, string | undefined> },
): Promise<ScenarioRunResult> {
  const log = opts.log ?? (() => {});
  const cfg = loaded.config;
  const dir = join(runDir, scenarioDirName(scenario.key));
  const shotsDir = join(dir, 'shots');
  const tmpVideo = join(dir, '.video-tmp');
  await mkdir(shotsDir, { recursive: true });
  const viewport = scenario.viewport ?? cfg.viewport ?? { width: 1280, height: 720 };
  const baseURL = scenario.baseURL ?? opts.baseURL;
  const startedAt = new Date();
  const redact = { ...(cfg.redact ?? {}) };
  const { selectors, attribute, style } = { selectors: [...(redact.selectors ?? []), ...scenario.redact], attribute: redact.attribute ?? 'data-receipts-redact', style: redact.style ?? 'blur' };
  const scrubber = new Scrubber({ headers: redact.headers, patterns: redact.patterns });
  const flagState: FlagState = { current: { ...scenario.flags } };
  const flags = new FlagApplier(cfg.flags?.adapters ?? [], flagState);
  const videoEnabled = cfg.video?.enabled ?? true;

  const personaFile = await (async () => {
    if (!opts.personaFiles.has(scenario.persona))
      opts.personaFiles.set(scenario.persona, await ensurePersonaState(browser, loaded, scenario.persona, baseURL, !!opts.freshPersonas));
    return opts.personaFiles.get(scenario.persona);
  })();
  if (personaFile) {
    const st = JSON.parse(readFileSync(personaFile, 'utf8'));
    scrubber.addLiterals((st.cookies ?? []).map((c: any) => c.value));
    for (const o of st.origins ?? []) scrubber.addLiterals((o.localStorage ?? []).map((kv: any) => kv.value));
  }

  const context = await browser.newContext({
    baseURL,
    viewport,
    storageState: personaFile,
    recordVideo: videoEnabled ? { dir: tmpVideo, size: viewport } : undefined,
    reducedMotion: 'no-preference',
  });
  context.setDefaultTimeout(cfg.actionTimeout ?? 10_000);
  await context.tracing.start({ screenshots: cfg.trace?.screenshots ?? false, snapshots: true, sources: false, title: `${scenario.key} @ ${git.shortSha}` });

  const steps: StepResult[] = scenario.steps.map((s, i) => ({
    index: i + 1,
    id: s.id,
    chapter: stepTitle(s),
    action: stepAction(s),
    status: 'skipped',
    startedAt: '',
    durationMs: 0,
    videoOffsetMs: 0,
    assertions: [],
  }));
  let chapter: ChapterState | null = null;
  if (cfg.chapters?.enabled ?? true) await installOverlay(context, () => chapter);
  await installRedaction(context, redactionCss(selectors, attribute, style));
  await flags.apply(context, baseURL);

  const page = await context.newPage();
  const t0 = Date.now(); // video timeline origin
  const live: Live = {
    scenario, loaded, baseURL, browser, context, page, flags, flagState, scrubber,
    requests: [], consoleLog: [], currentStep: 0, personaFiles: opts.personaFiles, freshPersonas: !!opts.freshPersonas,
  };
  page.on('console', (m) => {
    const t = m.type();
    if (t === 'error' || t === 'warning' || t === 'log' || t === 'info')
      live.consoleLog.push({ type: t === 'warning' ? 'warning' : t, text: m.text(), location: m.location()?.url, ts: Date.now() - t0, step: live.currentStep });
  });
  page.on('pageerror', (e) => live.consoleLog.push({ type: 'error', text: `Uncaught ${e.name}: ${e.message}`, ts: Date.now() - t0, step: live.currentStep }));
  context.on('request', (r) => live.requests.push({ method: r.method(), url: r.url(), resourceType: r.resourceType(), ts: Date.now() - t0, step: live.currentStep }));
  context.on('requestfinished', async (r) => {
    const rec = [...live.requests].reverse().find((q) => q.url === r.url() && q.method === r.method() && q.status === undefined);
    if (rec) rec.status = (await r.response().catch(() => null))?.status();
  });
  context.on('requestfailed', (r) => {
    const rec = [...live.requests].reverse().find((q) => q.url === r.url() && q.method === r.method() && q.status === undefined);
    if (rec) rec.failed = r.failure()?.errorText ?? 'failed';
  });
  const consoleCounts = () => ({
    errors: live.consoleLog.filter((c) => c.type === 'error').length,
    warnings: live.consoleLog.filter((c) => c.type === 'warning').length,
  });

  let fatal: string | undefined;
  let maskedMax = 0;
  const pii = new Set<string>();
  const notePii = async () => {
    const r = await collectRedactedText(page, selectors, attribute);
    maskedMax = Math.max(maskedMax, r.count);
    r.texts.forEach((t) => pii.add(t));
    return r.count;
  };

  try {
    // Setup steps run before the first chapter (e.g. API calls to reset state).
    for (const s of scenario.setup) await runAction(live, s);
  } catch (e) {
    fatal = `setup failed: ${(e as Error).message.split('\n')[0]}`;
  }

  const expectTimeout = cfg.expectTimeout ?? 5000;
  const holdMs = cfg.chapters?.holdMs ?? 900;
  let failed = !!fatal;
  for (let i = 0; i < scenario.steps.length && !failed; i++) {
    const step = scenario.steps[i]!;
    const res = steps[i]!;
    live.currentStep = i + 1;
    const st = Date.now();
    res.startedAt = new Date().toISOString();
    res.videoOffsetMs = st - t0;
    chapter = { title: res.chapter, index: i + 1, total: scenario.steps.length, key: scenario.key };
    log(`  ▸ ${i + 1}/${scenario.steps.length} ${res.chapter}`);
    try {
      const shown = cfg.chapters?.enabled === false ? true : await showChapterCard(page, chapter, holdMs);
      await runAction(live, step);
      if (!shown && cfg.chapters?.enabled !== false) await showChapterCard(page, chapter, holdMs);
      for (const a of step.expect ?? []) {
        const r = await runAssertion(a, { page, baseURL, timeout: expectTimeout, requests: live.requests, consoleCounts, judge: judgeHook(live, res) });
        res.assertions.push(r);
        log(`      ${r.status === 'passed' ? '✓' : r.status === 'failed' ? '✗' : '·'} ${r.aiJudged ? '[AI] ' : ''}${r.description}${r.actual ? ` → ${r.actual}` : ''}`);
      }
      res.status = res.assertions.some((a) => a.status === 'failed') ? 'failed' : 'passed';
    } catch (e) {
      res.status = 'failed';
      res.error = (e as Error).message.split('\n').slice(0, 3).join(' ').slice(0, 500);
      log(`      ✗ ${res.error}`);
    }
    res.url = page.url();
    const cap = step.capture ?? step.screenshot ?? (res.status === 'failed' ? `failure-step-${i + 1}` : undefined);
    if (cap) {
      const name = typeof cap === 'string' ? cap : cap.name;
      const fullPage = typeof cap === 'object' ? cap.fullPage : false;
      const file = `${String(i + 1).padStart(2, '0')}-${name.replace(/[^a-z0-9-_]+/gi, '-')}.png`;
      try {
        const masked = await notePii();
        await page.screenshot({ path: join(shotsDir, file), fullPage, mask: maskLocators(live).mask, maskColor: '#111', style: OVERLAY_HIDE_CSS, animations: 'disabled' });
        res.screenshot = { name, path: `shots/${file}`, maskedElements: masked };
      } catch (e) {
        res.error = (res.error ? res.error + '; ' : '') + `screenshot failed: ${(e as Error).message.split('\n')[0]}`;
      }
    } else await notePii();
    res.durationMs = Date.now() - st;
    if (res.status === 'failed') failed = true;
  }

  let resolvedFlags: Record<string, unknown> | undefined;
  try {
    resolvedFlags = cfg.flags?.readResolved && page.url() !== 'about:blank' ? await cfg.flags.readResolved(page) : undefined;
  } catch {
    resolvedFlags = undefined;
  }
  // Every cookie/session value seen during the run is a literal secret for the scrubber.
  try {
    scrubber.addLiterals((await context.cookies()).map((c) => c.value));
  } catch { /* ignore */ }
  const piiList = [...pii].filter((t) => t.length >= 4);
  scrubber.literals.push(...piiList.filter((t) => !scrubber.literals.includes(t)));
  scrubber.literals.sort((a, b) => b.length - a.length);

  const tracePath = join(dir, 'trace.zip');
  await context.tracing.stop({ path: tracePath });
  const video = page.video();
  const endMs = Date.now() - t0;
  await context.close();

  const artifacts: ArtifactRecord[] = [];
  let videoRel: string | undefined;
  if (video) {
    const webm = await video.path();
    const chapters = steps.filter((s) => s.startedAt).map((s) => ({ title: `${s.index}. ${s.chapter}`, startMs: s.videoOffsetMs }));
    if ((cfg.video?.mp4 ?? true) && (await hasFfmpeg())) {
      try {
        await webmToMp4(webm, join(dir, 'video.mp4'), chapters, endMs);
        videoRel = 'video.mp4';
      } catch (e) {
        log(`  (mp4 conversion failed, keeping webm: ${(e as Error).message.split('\n')[0]})`);
      }
    }
    if (!videoRel) {
      await rename(webm, join(dir, 'video.webm'));
      videoRel = 'video.webm';
    }
    await rm(tmpVideo, { recursive: true, force: true });
    artifacts.push(await artifactRecord(dir, videoRel, 'video'));
  }

  // Scrub traces and logs before anything is written next to them.
  await scrubTraceZip(tracePath, scrubber, { dropBodiesFor: redact.dropBodiesFor, maxBodyBytes: cfg.trace?.maxBodyBytes });
  const consoleOut = live.consoleLog.map((c) => ({ ...c, text: scrubber.scrubText(c.text), location: c.location ? scrubber.scrubText(c.location) : undefined }));
  const networkOut = live.requests.map((r) => ({ ...r, url: scrubber.scrubText(r.url) }));
  await writeFile(join(dir, 'console.json'), JSON.stringify(consoleOut, null, 2));
  await writeFile(join(dir, 'network.json'), JSON.stringify(networkOut, null, 2));
  const residual = [
    ...(await scanForSecrets(tracePath, scrubber)),
    ...(await scanForSecrets(join(dir, 'console.json'), scrubber)),
    ...(await scanForSecrets(join(dir, 'network.json'), scrubber)),
  ];

  for (const s of steps) if (s.screenshot) artifacts.push(await artifactRecord(dir, s.screenshot.path, 'screenshot'));
  artifacts.push(await artifactRecord(dir, 'trace.zip', 'trace'));
  artifacts.push(await artifactRecord(dir, 'console.json', 'log'));
  artifacts.push(await artifactRecord(dir, 'network.json', 'log'));

  const verdicts = countVerdicts(steps);
  const stepFailed = steps.some((s) => s.status === 'failed');
  const status: Manifest['status'] = fatal ? 'error' : stepFailed ? 'failed' : 'passed';
  const verdictsDoc = {
    key: scenario.key,
    status,
    steps: steps.map((s) => ({ index: s.index, chapter: s.chapter, status: s.status, assertions: s.assertions, error: s.error })),
  };
  await writeFile(join(dir, 'verdicts.json'), JSON.stringify(verdictsDoc, null, 2));
  artifacts.push(await artifactRecord(dir, 'verdicts.json', 'verdicts'));

  const limitations = [
    'Video timeline offsets are measured from page creation and may drift by ~100ms.',
    'Redaction covers configured selectors only; unconfigured PII on screen is not detected.',
  ];
  if (verdicts.aiJudged.skipped) limitations.push(`${verdicts.aiJudged.skipped} AI-judged check(s) were skipped (judge disabled).`);
  if (git.dirty) limitations.push('Working tree had uncommitted changes; evidence may not match the commit exactly.');
  if (!resolvedFlags && Object.keys(scenario.flags).length) limitations.push('Resolved flag state not read back from the app (flags.readResolved not configured).');

  const manifest = sealManifest({
    schema: 'receipts.manifest/v1',
    runId,
    key: scenario.key,
    scenarioId: scenario.scenarioId,
    variantId: scenario.variantId,
    title: scenario.title,
    tags: scenario.tags,
    covers: scenario.covers,
    status,
    error: fatal,
    git,
    scenario: { file: scenario.sourceFile ? relative(loaded.root, scenario.sourceFile) : undefined, hash: scenario.hash, compiledHash: compiledHashFor(loaded, scenario) },
    environment: {
      browser: 'chromium',
      browserVersion: browser.version(),
      playwright: PW_VERSION,
      node: process.version,
      os: `${os.platform()} ${os.release()}`,
      baseURL,
      viewport,
      headless: opts.headless,
    },
    persona: { name: scenario.persona, label: cfg.personas?.[scenario.persona]?.label },
    flags: { requested: scenario.flags, resolved: resolvedFlags, adapters: flags.types },
    timing: { startedAt: startedAt.toISOString(), endedAt: new Date().toISOString(), durationMs: Date.now() - startedAt.getTime() },
    steps,
    verdicts,
    console: consoleCounts(),
    network: { requests: live.requests.length, failed: live.requests.filter((r) => r.failed || (r.status ?? 0) >= 400).length },
    redaction: { selectors, attribute, style, maskedElementsMax: maskedMax, scrubber: scrubber.stats, residualSecrets: residual.length },
    artifacts,
    limitations,
  });
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return { manifest, dir };
}

export async function runScenarios(loaded: LoadedConfig, scenarios: ResolvedScenario[], opts: RunOptions = {}): Promise<{ summary: RunSummary; runDir: string; results: ScenarioRunResult[] }> {
  const log = opts.log ?? ((s: string) => process.stderr.write(s + '\n'));
  const cfg = loaded.config;
  const baseURL = opts.baseURL ?? process.env.RECEIPTS_BASE_URL ?? cfg.baseURL;
  const allow = cfg.allowHosts ?? DEFAULT_ALLOW_HOSTS;
  if (!hostAllowed(baseURL, allow)) throw new Error(`baseURL ${baseURL} is not in allowHosts (${allow.join(', ')}). Receipts refuses to record non-test hosts.`);
  const runId = opts.runId ?? newRunId();
  const runDir = join(loaded.runsDir, runId);
  await mkdir(runDir, { recursive: true });
  const git = gitInfo(loaded.root);
  const server = cfg.webServer && !opts.baseURL ? await startWebServer(cfg.webServer, loaded.root, log) : undefined;
  const headless = opts.headed ? false : cfg.headless ?? true;
  const browser = await chromium.launch({ headless });
  const started = Date.now();
  const results: ScenarioRunResult[] = [];
  const personaFiles = new Map<string, string | undefined>();
  try {
    for (const s of scenarios) {
      log(`● ${s.key} — ${s.title}`);
      try {
        const r = await runOne(browser, loaded, s, runDir, runId, git, { ...opts, baseURL, headless, personaFiles, log });
        results.push(r);
        log(`  ${r.manifest.status === 'passed' ? '✅ passed' : '❌ ' + r.manifest.status} (${(r.manifest.timing.durationMs / 1000).toFixed(1)}s)`);
      } catch (e) {
        log(`  ❌ error: ${(e as Error).message}`);
        throw e;
      }
    }
  } finally {
    await browser.close();
    await server?.stop();
  }
  const summary: RunSummary = {
    schema: 'receipts.run/v1',
    runId,
    createdAt: new Date(started).toISOString(),
    git,
    baseURL,
    browser: `chromium ${browser.version()}`,
    durationMs: Date.now() - started,
    scenarios: results.map(({ manifest: m, dir }) => ({
      key: m.key,
      title: m.title,
      status: m.status,
      dir: relative(runDir, dir),
      covers: m.covers,
      tags: m.tags,
      persona: m.persona.name,
      flags: m.flags.requested,
      durationMs: m.timing.durationMs,
      verdicts: m.verdicts,
      video: m.artifacts.find((a) => a.kind === 'video')?.path,
      screenshots: m.artifacts.filter((a) => a.kind === 'screenshot').length,
      highlights: m.steps.flatMap((s) => s.assertions.filter((a) => a.kind === 'media' || a.kind === 'request' || a.kind === 'console').map((a) => `${a.description} → ${a.actual ?? a.status}`)).slice(0, 4),
    })),
    totals: { passed: results.filter((r) => r.manifest.status === 'passed').length, failed: results.filter((r) => r.manifest.status !== 'passed').length },
  };
  await writeFile(join(runDir, 'run.json'), JSON.stringify(summary, null, 2));
  // Convenience pointer for `receipts open` with no args.
  await writeFile(join(loaded.runsDir, 'latest'), runId + '\n');
  return { summary, runDir, results };
}
