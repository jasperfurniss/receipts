import { describe, expect, it } from 'vitest';
import { parseScenario, resolveScenario } from '../scenario/parse.js';
import { compileAssertion, compileFile, compileStepBody } from '../compile/compiler.js';
import { stepHash } from '../compile/cache.js';

describe('compiler', () => {
  it('compiles assertions to Playwright expectations', () => {
    expect(compileAssertion({ visible: { role: 'region', name: 'Lesson video' } })).toBe(
      'await expect(page.getByRole("region", { name: "Lesson video" }), "role=region[name=\\"Lesson video\\"] is visible").toBeVisible();',
    );
    expect(compileAssertion({ visible: { text: '/Resuming from 0:4\\d/' } })).toContain('page.getByText(/Resuming from 0:4\\d/)');
    expect(compileAssertion({ request: { method: 'PUT', url: '/api/**', times: '>=1' } })).toContain('.toBeGreaterThanOrEqual(1)');
    expect(compileAssertion({ request: { url: '/api/**', times: 0 } })).toMatch(/waitForTimeout\(750\);\nexpect\(receipts\.requestCount\(.*\)\.toBe\(0\);/);
    expect(compileAssertion({ media: { time: 42, tolerance: 3 } })).toContain('- 42), "video currentTime ≈ 42 ± 3s").toBeLessThanOrEqual(3)');
    expect(compileAssertion({ eval: "document.title === 'x'" })).toContain('expect.poll(() => page.evaluate("document.title === \'x\'")');
    expect(compileAssertion({ judge: 'looks right' })).toContain('AI-judged');
    expect(compileAssertion({ console: { errors: 0 } })).toContain('consoleErrors()');
  });

  it('compiles action steps deterministically', () => {
    const body = compileStepBody(
      { goto: '/x', fill: { target: { label: 'Email' }, value: 'a@b.c' }, click: { role: 'button', name: 'Go' }, media: { play: true }, wait: { selector: 'video', state: 'attached' }, capture: 'shot' },
      {},
    );
    expect(body.split('\n')).toEqual([
      'await page.goto(receipts.url("/x"));',
      'await page.getByRole("button", { name: "Go" }).click();',
      'await page.getByLabel("Email").fill("a@b.c");',
      'await receipts.media({"play":true});',
      'await page.waitForSelector("video", { state: "attached" });',
      'await receipts.capture("shot");',
    ]);
  });

  it('inlines cached code for natural-language steps and marks uncompiled ones', () => {
    const instr = 'Start playback then seek to 40s';
    const cached = compileStepBody({ do: instr }, { [stepHash(instr)]: { instruction: instr, code: 'await page.click("x");', source: 'manual', createdAt: '' } });
    expect(cached).toContain('await page.click("x");');
    expect(compileStepBody({ do: instr }, {})).toContain('throw new Error');
  });

  it('produces stable output (same input → same file)', () => {
    const src = 'id: a\ntitle: A\nsteps:\n  - chapter: One\n    goto: /\n    expect:\n      - url: "**/"\nvariants:\n  - id: off\n    flags: { f: off }\n';
    const r = resolveScenario(parseScenario(src));
    const a = compileFile(r, src, 'a.yml', {});
    expect(compileFile(r, src, 'a.yml', {})).toBe(a);
    expect(a).toContain("import { test, expect } from '@receipts/core/fixture';");
    expect(a).toContain('test.describe("a/off"');
    expect(a).toContain('receiptsFlags: {"f":false}');
  });
});
