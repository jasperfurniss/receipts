import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import type { LoadedConfig } from '../config.js';
import type { Assertion, ResolvedScenario, Step } from '../scenario/schema.js';
import { sha256 } from '../hash.js';
import { describeAssertion } from '../runner/assertions.js';
import { targetToCode } from '../runner/locate.js';
import { parseRegexLiteral } from '../glob.js';
import { readStepCache, stepHash, type StepCache } from './cache.js';

const J = JSON.stringify;
const ind = (s: string, n: number) => s.split('\n').map((l) => (l ? ' '.repeat(n) + l : l)).join('\n');

function stepTitle(step: Step, i: number): string {
  const t =
    step.chapter ??
    (step.goto ? `Go to ${step.goto}` : step.do ? step.do : step.click ? 'Click' : step.fill ? 'Fill' : step.expect ? 'Check' : 'Step');
  return `${i + 1}. ${t}`;
}

function timesToMatcher(times: number | string | undefined): { matcher: string; n: number; upper: boolean } {
  if (times === undefined) return { matcher: 'toBeGreaterThanOrEqual', n: 1, upper: false };
  if (typeof times === 'number') return { matcher: 'toBe', n: times, upper: true };
  const m = /^(>=|<=|>|<|==|=)?\s*(\d+)$/.exec(times.trim())!;
  const n = Number(m[2]);
  switch (m[1]) {
    case '>=': return { matcher: 'toBeGreaterThanOrEqual', n, upper: false };
    case '>': return { matcher: 'toBeGreaterThan', n, upper: false };
    case '<=': return { matcher: 'toBeLessThanOrEqual', n, upper: true };
    case '<': return { matcher: 'toBeLessThan', n, upper: true };
    default: return { matcher: 'toBe', n, upper: true };
  }
}

export function compileAssertion(a: Assertion): string {
  const d = describeAssertion(a);
  const msg = J(d.description);
  if ('visible' in a) return `await expect(${targetToCode(a.visible)}, ${msg}).toBeVisible();`;
  if ('hidden' in a) return `await expect(${targetToCode(a.hidden)}, ${msg}).toBeHidden();`;
  if ('text' in a) {
    const loc = a.text.target ? `${targetToCode(a.text.target)}.first()` : `page.locator('body')`;
    if (a.text.equals !== undefined) return `await expect(${loc}, ${msg}).toHaveText(${J(a.text.equals)});`;
    if (a.text.matches !== undefined) {
      const re = parseRegexLiteral(a.text.matches) ?? new RegExp(a.text.matches);
      return `await expect(${loc}, ${msg}).toContainText(${re.toString()});`;
    }
    return `await expect(${loc}, ${msg}).toContainText(${J(a.text.contains ?? '')});`;
  }
  if ('url' in a) return `await expect.poll(() => receipts.urlMatches(${J(a.url)}, page.url()), ${msg}).toBe(true);`;
  if ('title' in a) {
    const re = parseRegexLiteral(a.title);
    return `await expect(page, ${msg}).toHaveTitle(${re ? re.toString() : J(a.title)});`;
  }
  if ('eval' in a) return `await expect.poll(() => page.evaluate(${J(a.eval)}), ${msg}).toBeTruthy();`;
  if ('request' in a) {
    const { matcher, n, upper } = timesToMatcher(a.request.times);
    const q = `{ method: ${J(a.request.method)}, url: ${J(a.request.url)}${a.request.status !== undefined ? `, status: ${a.request.status}` : ''} }`;
    return upper
      ? `await page.waitForTimeout(750);\nexpect(receipts.requestCount(${q}), ${msg}).${matcher}(${n});`
      : `await expect.poll(() => receipts.requestCount(${q}), ${msg}).${matcher}(${n});`;
  }
  if ('console' in a) {
    const out: string[] = [];
    if (a.console.errors !== undefined) out.push(`expect(receipts.consoleErrors(), ${msg}).toBeLessThanOrEqual(${a.console.errors});`);
    if (a.console.warnings !== undefined) out.push(`expect(receipts.consoleWarnings(), ${msg}).toBeLessThanOrEqual(${a.console.warnings});`);
    return out.join('\n');
  }
  if ('media' in a) {
    const m = a.media;
    const sel = J(m.selector ?? 'video');
    const out: string[] = [];
    if (m.time !== undefined) out.push(`await expect.poll(async () => Math.abs((await receipts.mediaTime(${sel})) - ${m.time}), ${msg}).toBeLessThanOrEqual(${m.tolerance ?? 1});`);
    if (m.gte !== undefined) out.push(`await expect.poll(() => receipts.mediaTime(${sel}), ${msg}).toBeGreaterThanOrEqual(${m.gte});`);
    if (m.lte !== undefined) out.push(`await expect.poll(() => receipts.mediaTime(${sel}), ${msg}).toBeLessThanOrEqual(${m.lte});`);
    if (m.paused !== undefined) out.push(`await expect.poll(() => page.evaluate((s) => (document.querySelector(s) as HTMLMediaElement).paused, ${sel}), ${msg}).toBe(${m.paused});`);
    return out.join('\n');
  }
  return `// 🤖 AI-judged (only evaluated by \`receipts run\` with ai.judge enabled): ${J(a.judge)}\nawait receipts.judge(${J(a.judge)});`;
}

export function compileStepBody(step: Step, cache: StepCache): string {
  const out: string[] = [];
  if (step.goto) out.push(`await page.goto(receipts.url(${J(step.goto)}));`);
  if (step.reload) out.push(`await page.reload();`);
  if (step.back) out.push(`await page.goBack();`);
  if (step.flag) out.push(`await receipts.setFlags(${J(step.flag)});`);
  if (step.signOut) out.push(`await receipts.signOut();`);
  if (step.signIn) out.push(`await receipts.signIn(${J(step.signIn)});`);
  if (step.api) out.push(`await receipts.api(${J(step.api)});`);
  if (step.click) out.push(`await ${targetToCode(step.click)}.click();`);
  if (step.dblclick) out.push(`await ${targetToCode(step.dblclick)}.dblclick();`);
  if (step.hover) out.push(`await ${targetToCode(step.hover)}.hover();`);
  if (step.fill) out.push(`await ${targetToCode(step.fill.target)}.fill(${J(step.fill.value)});`);
  if (step.select) out.push(`await ${targetToCode(step.select.target)}.selectOption(${J(step.select.value)});`);
  if (step.check) out.push(`await ${targetToCode(step.check)}.check();`);
  if (step.uncheck) out.push(`await ${targetToCode(step.uncheck)}.uncheck();`);
  if (step.press) {
    if (typeof step.press === 'string') out.push(`await page.keyboard.press(${J(step.press)});`);
    else if (step.press.target) out.push(`await ${targetToCode(step.press.target)}.press(${J(step.press.key)});`);
    else out.push(`await page.keyboard.press(${J(step.press.key)});`);
  }
  const code = step.eval ?? step.evaluate;
  if (code) out.push(`await page.evaluate(${J(/\breturn\b|;|\n/.test(code.trim()) ? `(async () => { ${code} })()` : code)});`);
  if (step.media) out.push(`await receipts.media(${J(step.media)});`);
  if (step.do) {
    const hit = cache[stepHash(step.do)];
    if (hit) out.push(`// do: ${J(step.do)} (compiled ${hit.source}${hit.provider ? ` by ${hit.provider}` : ''}, step hash ${stepHash(step.do)})`, hit.code.trim());
    else out.push(`// do: ${J(step.do)} — NOT COMPILED (needs an AI provider, or hand-written code in steps.json)`, `throw new Error(${J(`natural-language step not compiled: ${step.do}`)});`);
  }
  if (step.sleep) out.push(`await page.waitForTimeout(${step.sleep});`);
  const w = step.wait ?? step.waitFor;
  if (w !== undefined) {
    if (typeof w === 'number') out.push(`await page.waitForTimeout(${w});`);
    else if ('ms' in w) out.push(`await page.waitForTimeout(${w.ms});`);
    else if ('selector' in w) out.push(`await page.waitForSelector(${J(w.selector)}, { state: ${J(w.state ?? 'visible')} });`);
    else if ('url' in w) out.push(`await page.waitForURL((u) => receipts.urlMatches(${J(w.url)}, u.toString()));`);
    else if ('load' in w) out.push(`await page.waitForLoadState(${J(w.load)});`);
    else if ('request' in w) out.push(`await page.waitForRequest((r) => receipts.urlMatches(${J(w.request)}, r.url())${w.method ? ` && r.method() === ${J(w.method.toUpperCase())}` : ''});`);
  }
  for (const a of step.expect ?? []) out.push(compileAssertion(a));
  const cap = step.capture ?? step.screenshot;
  if (cap) out.push(`await receipts.capture(${J(typeof cap === 'string' ? cap : cap.name)});`);
  return out.join('\n');
}

export function compileResolved(r: ResolvedScenario, cache: StepCache): string {
  const lines: string[] = [];
  lines.push(`test.describe(${J(r.key)}, () => {`);
  lines.push(`  test.use({ receiptsPersona: ${J(r.persona)}, receiptsFlags: ${J(r.flags)}, receiptsRedact: ${J(r.redact)}${r.viewport ? `, viewport: ${J(r.viewport)}` : ''} });`);
  lines.push('');
  const tags = r.tags.length ? `, { tag: ${J(r.tags.map((t) => '@' + t))} }` : '';
  lines.push(`  test(${J(r.title)}${tags}, async ({ page, receipts }) => {`);
  if (r.setup.length) {
    lines.push(`    // setup`);
    for (const s of r.setup) lines.push(ind(compileStepBody(s, cache), 4));
  }
  r.steps.forEach((s, i) => {
    lines.push(`    await test.step(${J(stepTitle(s, i))}, async () => {`);
    lines.push(`      await receipts.chapter(${J(s.chapter ?? stepTitle(s, i).replace(/^\d+\. /, ''))}, ${i + 1}, ${r.steps.length});`);
    lines.push(ind(compileStepBody(s, cache), 6));
    lines.push(`    });`);
  });
  lines.push(`  });`);
  lines.push(`});`);
  return lines.join('\n');
}

export function compileFile(resolved: ResolvedScenario[], source: string, sourceRel: string, cache: StepCache): string {
  const head = [
    `// Generated by \`receipts compile\` from ${sourceRel}. Review it like code; regenerate instead of editing.`,
    `// source-sha256: ${sha256(source)}`,
    `// Runnable with plain Playwright Test: npx playwright test ${'<this file>'}`,
    `import { test, expect } from '@receipts/core/fixture';`,
    '',
  ];
  return head.join('\n') + resolved.map((r) => `// scenario-hash ${r.key}: ${r.hash}\n` + compileResolved(r, cache)).join('\n\n') + '\n';
}

export function compiledPathFor(loaded: LoadedConfig, scenarioId: string) {
  return join(loaded.compiledDir, `${scenarioId}.spec.ts`);
}

export function compiledHashFor(loaded: LoadedConfig, r: ResolvedScenario): string | undefined {
  const p = compiledPathFor(loaded, r.scenarioId);
  if (!existsSync(p)) return undefined;
  return sha256(readFileSync(p));
}

export interface CompileResult {
  file: string;
  changed: boolean;
  uncompiledSteps: string[];
}

export function compileScenarioFile(
  loaded: LoadedConfig,
  file: string,
  resolved: ResolvedScenario[],
  source: string,
  opts: { check?: boolean } = {},
): CompileResult {
  const cache = readStepCache(loaded.compiledDir);
  const code = compileFile(resolved, source, relative(loaded.root, file), cache);
  const out = compiledPathFor(loaded, resolved[0]!.scenarioId);
  const prev = existsSync(out) ? readFileSync(out, 'utf8') : undefined;
  const changed = prev !== code;
  if (!opts.check && changed) {
    mkdirSync(loaded.compiledDir, { recursive: true });
    writeFileSync(out, code);
  }
  const uncompiled = resolved.flatMap((r) => [...r.setup, ...r.steps]).filter((s) => s.do && !cache[stepHash(s.do)]).map((s) => s.do!);
  void basename;
  return { file: out, changed, uncompiledSteps: [...new Set(uncompiled)] };
}
