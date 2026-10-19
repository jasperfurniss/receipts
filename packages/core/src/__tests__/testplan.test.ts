import { describe, expect, it } from 'vitest';
import { parseTestPlan, mapTestPlan, coverScore, annotateTestPlan, itemStatus } from '../testplan.js';

const BODY = `## Summary
- [ ] not a test plan item

## Test Plan
- [ ] Signed-in learner: watch ~40s, leave, return → video resumes at ~40s
- [x] Flag off → video starts at 0:00
  - [ ] Signed out → video starts at 0:00, no progress API calls
* [ ] No console errors on the lesson page
- [ ] Copy reviewed by design

\`\`\`
- [ ] inside a fence
\`\`\`

## Notes
- [ ] after the plan
`;

const SOURCES = [
  { key: 'video-resume', covers: ['Signed-in learner: watch ~40s, leave, return', 'No console errors on the lesson page'] },
  { key: 'video-resume/flag-off', covers: ['Flag off → video starts at 0:00'] },
  { key: 'video-resume/signed-out', covers: ['Signed out → video starts at 0:00, no progress API calls'] },
  { key: 'sign-in', covers: ['Sign in with email and password'] },
];

describe('test plan', () => {
  it('extracts only checkboxes under a Test Plan heading', () => {
    const items = parseTestPlan(BODY);
    expect(items.map((i) => i.text)).toEqual([
      'Signed-in learner: watch ~40s, leave, return → video resumes at ~40s',
      'Flag off → video starts at 0:00',
      'Signed out → video starts at 0:00, no progress API calls',
      'No console errors on the lesson page',
      'Copy reviewed by design',
    ]);
    expect(items[1]!.checked).toBe(true);
    expect(items[2]!.indent).toBe(2);
  });

  it('accepts heading variants and CRLF', () => {
    expect(parseTestPlan('### Testing plan\r\n- [ ] a\r\n').length).toBe(1);
    expect(parseTestPlan('## How to test\n- [ ] a').length).toBe(1);
    expect(parseTestPlan('## Changes\n- [ ] a').length).toBe(0);
  });

  it('fuzzy-matches covers and leaves unmapped items manual', () => {
    const m = mapTestPlan(parseTestPlan(BODY), SOURCES);
    expect(m.map((x) => x.scenarios.map((s) => s.key))).toEqual([
      ['video-resume'],
      ['video-resume/flag-off'],
      ['video-resume/signed-out'],
      ['video-resume'],
      [],
    ]);
  });

  it('scores containment high and unrelated text low', () => {
    expect(coverScore('Flag off → video starts at 0:00', 'Flag off → video starts at 0:00')).toBe(1);
    expect(coverScore('Signed-in learner: watch ~40s, leave, return → resumes', 'Signed-in learner: watch ~40s, leave, return')).toBeGreaterThan(0.8);
    expect(coverScore('Copy reviewed by design', 'No console errors on the lesson page')).toBeLessThan(0.3);
    expect(coverScore('video plays', 'video')).toBeLessThan(0.9);
  });

  it('annotates checkboxes idempotently and only ticks verified items', () => {
    const m = mapTestPlan(parseTestPlan(BODY), SOURCES);
    const results = { 'video-resume': 'passed', 'video-resume/flag-off': 'failed', 'video-resume/signed-out': 'passed' } as const;
    expect(itemStatus(m[0]!, results)).toBe('verified');
    expect(itemStatus(m[1]!, results)).toBe('failed');
    expect(itemStatus(m[4]!, results)).toBe('manual');
    const once = annotateTestPlan(BODY, m, results, (k) => `https://v/${k}`);
    const twice = annotateTestPlan(once, mapTestPlan(parseTestPlan(once), SOURCES), results, (k) => `https://v/${k}`);
    expect(twice).toBe(once);
    expect(once).toContain('- [x] Signed-in learner: watch ~40s, leave, return → video resumes at ~40s <!-- receipts --> ✅ [evidence](https://v/video-resume)');
    expect(once).toContain('- [x] Flag off → video starts at 0:00 <!-- receipts --> ❌ [failed]'); // keeps author's manual tick
    expect(once).toContain('- [ ] Copy reviewed by design\n');
  });
});
