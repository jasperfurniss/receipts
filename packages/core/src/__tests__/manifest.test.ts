import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { artifactRecord, countVerdicts, sealManifest, verifyBundle, type Manifest, type StepResult } from '../manifest.js';
import { renderComment, renderCheck, STICKY_MARKER } from '../report/comment.js';
import { renderRunPage } from '../report/html.js';
import { mapTestPlan, parseTestPlan } from '../testplan.js';
import { checkTimes, globToRegExp, hostAllowed, urlMatches } from '../glob.js';

function step(over: Partial<StepResult>): StepResult {
  return { index: 1, chapter: 'Return', action: 'goto', status: 'passed', startedAt: 'x', durationMs: 10, videoOffsetMs: 1000, assertions: [], ...over };
}

async function bundle(): Promise<{ dir: string; m: Manifest }> {
  const dir = mkdtempSync(join(tmpdir(), 'rcpt-m-'));
  mkdirSync(join(dir, 'shots'));
  writeFileSync(join(dir, 'video.mp4'), 'v');
  writeFileSync(join(dir, 'shots/01-resumed.png'), 'p');
  writeFileSync(join(dir, 'trace.zip'), 't');
  const steps = [
    step({ assertions: [
      { kind: 'media', description: 'video currentTime ≈ 42 ± 3s', status: 'passed', aiJudged: false, actual: 'currentTime 41.8s (paused)' },
      { kind: 'judge', description: 'indicator near 0:42', status: 'skipped', aiJudged: true },
    ], screenshot: { name: 'resumed', path: 'shots/01-resumed.png', maskedElements: 2 } }),
    step({ index: 2, chapter: 'Health', assertions: [{ kind: 'console', description: '0 console errors', status: 'passed', aiJudged: false, actual: '0 error(s), 1 warning(s)' }] }),
  ];
  const m = sealManifest({
    schema: 'receipts.manifest/v1', runId: 'r1', key: 'video-resume', scenarioId: 'video-resume', title: 'Resumes', tags: [], covers: ['Signed-in learner: watch ~40s, leave, return'],
    status: 'passed', git: { sha: 'a1b2c3d4e5f6', shortSha: 'a1b2c3d', dirty: false, branch: 'feat' }, scenario: { hash: 'h'.repeat(64) },
    environment: { browser: 'chromium', browserVersion: '141', playwright: '1.64.1', node: 'v20', os: 'linux', baseURL: 'http://localhost:3000', viewport: { width: 1, height: 1 }, headless: true },
    persona: { name: 'learner' }, flags: { requested: { 'resume-playback': true }, adapters: ['cookie'] },
    timing: { startedAt: '', endedAt: '', durationMs: 1000 }, steps, verdicts: countVerdicts(steps), console: { errors: 0, warnings: 1 }, network: { requests: 1, failed: 0 },
    redaction: { selectors: ['.email'], attribute: 'data-receipts-redact', style: 'blur', maskedElementsMax: 2, scrubber: { headersStripped: 3, secretsReplaced: 1, bodiesDropped: 0, filesScanned: 2, byPattern: {} }, residualSecrets: 0 },
    artifacts: [await artifactRecord(dir, 'video.mp4', 'video'), await artifactRecord(dir, 'shots/01-resumed.png', 'screenshot'), await artifactRecord(dir, 'trace.zip', 'trace')],
    limitations: [],
  });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(m));
  return { dir, m };
}

describe('manifest', () => {
  it('counts deterministic and AI-judged verdicts separately', async () => {
    const { m } = await bundle();
    expect(m.verdicts.deterministic).toEqual({ passed: 2, failed: 0, skipped: 0 });
    expect(m.verdicts.aiJudged).toEqual({ passed: 0, failed: 0, unsure: 0, skipped: 1 });
  });

  it('content-hashes artifacts and detects tampering + staleness', async () => {
    const { dir, m } = await bundle();
    expect(m.artifacts[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect((await verifyBundle(dir)).ok).toBe(true);
    expect((await verifyBundle(dir, 'a1b2c3d')).stale).toBe(false);
    expect((await verifyBundle(dir, 'ffffff')).stale).toBe(true);
    writeFileSync(join(dir, 'video.mp4'), 'tampered');
    const v = await verifyBundle(dir);
    expect(v.ok).toBe(false);
    expect(v.artifacts.find((a) => a.path === 'video.mp4')!.reason).toBe('hash mismatch');
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ ...m, status: 'failed' }));
    expect((await verifyBundle(dir)).manifestHashOk).toBe(false);
  });

  it('renders the sticky comment, stale header, manual items and check', async () => {
    const { m } = await bundle();
    const summary = { schema: 'receipts.run/v1' as const, runId: 'r1', createdAt: '', git: m.git, baseURL: '', browser: 'chromium 141', durationMs: 112000, scenarios: [], totals: { passed: 1, failed: 0 } };
    const mappings = mapTestPlan(parseTestPlan('## Test Plan\n- [ ] Signed-in learner: watch ~40s, leave, return → resumes\n- [ ] Copy reviewed by design'), [{ key: 'video-resume', covers: m.covers }]);
    const link = (_m: Manifest, a?: string) => `https://receipts.internal/r/x#${a}`;
    const md = renderComment({ summary, manifests: [m], mappings, link, expiresDays: 30 });
    expect(md.startsWith(STICKY_MARKER)).toBe(true);
    expect(md).toContain('### 🧾 Receipts: 1/1 scenarios passed · 1/2 Test Plan items verified');
    expect(md).toContain('`a1b2c3d` · chromium 141 · persona `learner` · flags `resume-playback=on` · 1m 52s');
    expect(md).toContain('video currentTime ≈ 42 ± 3s → **currentTime 41.8s (paused)**');
    expect(md).toContain('⚪ manual');
    expect(md).toContain('🤖 *AI-judged*: indicator near 0:42');
    expect(md).toContain('[▶ video](https://receipts.internal/r/x#video)');
    expect(renderComment({ summary, manifests: [m], mappings, headSha: 'd4e5f6a0' })).toContain('⏳ Receipts: stale (evidence is for `a1b2c3d`, head is `d4e5f6a`)');
    expect(renderCheck({ summary, manifests: [m], mappings }).conclusion).toBe('success');
    expect(renderCheck({ summary, manifests: [], mappings }).conclusion).toBe('neutral');
    expect(renderCheck({ summary, manifests: [{ ...m, status: 'failed' }], mappings }).conclusion).toBe('failure');
    const html = renderRunPage({ ...summary, scenarios: [{ key: m.key, title: m.title, status: 'passed', dir: 'video-resume', covers: [], tags: [], persona: 'learner', flags: {}, durationMs: 1, verdicts: m.verdicts, screenshots: 1, highlights: [] }] }, [m], { asset: (d, r) => `${d}/${r}` });
    expect(html).toContain('src="video-resume/video.mp4"');
    expect(html).toContain('🤖 AI-judged');
    expect(html).not.toMatch(/https?:\/\/(?!receipts)/); // no external URLs baked into reports
  });
});

describe('globs', () => {
  it('matches Playwright-style URL globs', () => {
    expect(urlMatches('/api/me/progress/**', 'http://localhost:4173/api/me/progress/lessons/x')).toBe(true);
    expect(urlMatches('**/courses', 'http://localhost:4173/courses')).toBe(true);
    expect(urlMatches('/api/*', 'http://localhost/api/a/b')).toBe(false);
    expect(urlMatches('/\\/lessons\\/.+/', 'http://h/lessons/x')).toBe(true);
    expect(globToRegExp('a?c').test('abc')).toBe(true);
  });
  it('enforces host allowlist', () => {
    expect(hostAllowed('http://localhost:3000', ['localhost'])).toBe(true);
    expect(hostAllowed('https://pr-1.preview.internal', ['*.internal'])).toBe(true);
    expect(hostAllowed('https://app.example.com', ['localhost', '*.internal'])).toBe(false);
  });
  it('checks request counts', () => {
    expect(checkTimes('>=1', 2)).toBe(true);
    expect(checkTimes(0, 0)).toBe(true);
    expect(checkTimes('<2', 2)).toBe(false);
    expect(checkTimes(undefined, 0)).toBe(false);
  });
});
