import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { GitInfo } from './git.js';
import type { ScrubStats } from './scrub.js';
import { canonicalJson, sha256, sha256File } from './hash.js';

export type Status = 'passed' | 'failed' | 'skipped';
export type AssertionStatus = 'passed' | 'failed' | 'skipped' | 'warn' | 'unsure';

export interface AssertionResult {
  kind: string;
  description: string;
  expected?: string;
  actual?: string;
  status: AssertionStatus;
  /** True for checks decided by an LLM. These are always reported separately. */
  aiJudged: boolean;
  rationale?: string;
  confidence?: string;
  error?: string;
  durationMs?: number;
}

export interface StepResult {
  index: number;
  id?: string;
  chapter: string;
  action: string;
  status: Status;
  startedAt: string;
  durationMs: number;
  /** Offset into the video where this step's chapter starts. */
  videoOffsetMs: number;
  url?: string;
  assertions: AssertionResult[];
  screenshot?: { name: string; path: string; maskedElements: number };
  error?: string;
}

export interface ArtifactRecord {
  path: string;
  kind: 'video' | 'screenshot' | 'trace' | 'log' | 'verdicts' | 'other';
  sha256: string;
  bytes: number;
  contentType: string;
}

export interface Manifest {
  schema: 'receipts.manifest/v1';
  runId: string;
  key: string;
  scenarioId: string;
  variantId?: string;
  title: string;
  tags: string[];
  covers: string[];
  status: 'passed' | 'failed' | 'error';
  error?: string;
  git: GitInfo;
  scenario: { file?: string; hash: string; compiledHash?: string };
  environment: {
    browser: string;
    browserVersion: string;
    playwright: string;
    node: string;
    os: string;
    baseURL: string;
    viewport: { width: number; height: number };
    headless: boolean;
  };
  persona: { name: string; label?: string };
  flags: { requested: Record<string, boolean | string>; resolved?: Record<string, unknown>; adapters: string[] };
  timing: { startedAt: string; endedAt: string; durationMs: number };
  steps: StepResult[];
  verdicts: {
    deterministic: { passed: number; failed: number; skipped: number };
    aiJudged: { passed: number; failed: number; unsure: number; skipped: number };
  };
  console: { errors: number; warnings: number };
  network: { requests: number; failed: number };
  redaction: {
    selectors: string[];
    attribute: string;
    style: string;
    maskedElementsMax: number;
    scrubber: ScrubStats;
    residualSecrets: number;
  };
  artifacts: ArtifactRecord[];
  /** What this evidence can't show (provenance-style honesty). */
  limitations: string[];
  /** sha256 over the canonical manifest without this field. */
  manifestHash?: string;
}

export function contentTypeFor(path: string): string {
  if (path.endsWith('.mp4')) return 'video/mp4';
  if (path.endsWith('.webm')) return 'video/webm';
  if (path.endsWith('.png')) return 'image/png';
  if (path.endsWith('.zip')) return 'application/zip';
  if (path.endsWith('.json')) return 'application/json';
  if (path.endsWith('.html')) return 'text/html; charset=utf-8';
  if (path.endsWith('.md')) return 'text/markdown; charset=utf-8';
  return 'application/octet-stream';
}

export async function artifactRecord(dir: string, rel: string, kind: ArtifactRecord['kind']): Promise<ArtifactRecord> {
  const p = join(dir, rel);
  const [h, s] = await Promise.all([sha256File(p), stat(p)]);
  return { path: rel, kind, sha256: h, bytes: s.size, contentType: contentTypeFor(rel) };
}

export function countVerdicts(steps: StepResult[]): Manifest['verdicts'] {
  const v: Manifest['verdicts'] = {
    deterministic: { passed: 0, failed: 0, skipped: 0 },
    aiJudged: { passed: 0, failed: 0, unsure: 0, skipped: 0 },
  };
  for (const s of steps)
    for (const a of s.assertions) {
      if (a.aiJudged) {
        if (a.status === 'passed') v.aiJudged.passed++;
        else if (a.status === 'failed' || a.status === 'warn') v.aiJudged.failed++;
        else if (a.status === 'unsure') v.aiJudged.unsure++;
        else v.aiJudged.skipped++;
      } else {
        if (a.status === 'passed') v.deterministic.passed++;
        else if (a.status === 'failed') v.deterministic.failed++;
        else v.deterministic.skipped++;
      }
    }
  return v;
}

export function sealManifest(m: Manifest): Manifest {
  const { manifestHash: _ignored, ...rest } = m;
  return { ...m, manifestHash: sha256(canonicalJson(rest)) };
}

export interface VerifyResult {
  ok: boolean;
  manifestHashOk: boolean;
  artifacts: { path: string; ok: boolean; reason?: string }[];
  stale: boolean;
  headSha?: string;
}

/** Re-hash every artifact and the manifest itself; optionally check the SHA against a PR head. */
export async function verifyBundle(dir: string, headSha?: string): Promise<VerifyResult> {
  const m = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as Manifest;
  const { manifestHash, ...rest } = m;
  const manifestHashOk = manifestHash === sha256(canonicalJson(rest));
  const artifacts = await Promise.all(
    m.artifacts.map(async (a) => {
      try {
        const h = await sha256File(join(dir, a.path));
        return h === a.sha256 ? { path: a.path, ok: true } : { path: a.path, ok: false, reason: 'hash mismatch' };
      } catch {
        return { path: a.path, ok: false, reason: 'missing' };
      }
    }),
  );
  const stale = !!headSha && !headSha.startsWith(m.git.sha) && !m.git.sha.startsWith(headSha);
  return { ok: manifestHashOk && artifacts.every((a) => a.ok), manifestHashOk, artifacts, stale, headSha };
}

export interface RunSummaryEntry {
  key: string;
  title: string;
  status: Manifest['status'];
  dir: string;
  covers: string[];
  tags: string[];
  persona: string;
  flags: Record<string, boolean | string>;
  durationMs: number;
  verdicts: Manifest['verdicts'];
  video?: string;
  screenshots: number;
  highlights: string[];
}

export interface RunSummary {
  schema: 'receipts.run/v1';
  runId: string;
  createdAt: string;
  git: GitInfo;
  baseURL: string;
  browser: string;
  durationMs: number;
  scenarios: RunSummaryEntry[];
  /** Scenarios not run (e.g. persona storageState missing). */
  skipped?: { key: string; title: string; reason: string }[];
  totals: { passed: number; failed: number; skipped?: number };
  /** Optional PR context, set by `publish`/`ci`. */
  pr?: { number: number; repo?: string; headSha?: string };
}

export function scenarioDirName(key: string) {
  return key.replace(/\//g, '__');
}
