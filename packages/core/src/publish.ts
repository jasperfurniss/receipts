import { readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { ArtifactStore } from './store/index.js';
import { runPrefix } from './store/index.js';
import { contentTypeFor, verifyBundle, type RunSummary } from './manifest.js';
import { Scrubber, scanForSecrets } from './scrub.js';
import { sha256File } from './hash.js';
import { loadRun } from './report/html.js';

export class PublishBlockedError extends Error {}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

/**
 * Gate + upload a run bundle. Refuses to publish if any artifact fails its hash check or the
 * secret scanner still finds a known-secret pattern in traces/logs.
 */
export async function publishRun(
  runDir: string,
  store: ArtifactStore,
  o: { repo?: string; pr?: number; patterns?: string[] } = {},
): Promise<{ prefix: string; uploaded: number; skipped: number; summary: RunSummary }> {
  const { summary } = loadRun(runDir);
  const scanner = new Scrubber({ patterns: o.patterns });
  for (const s of summary.scenarios) {
    const dir = join(runDir, s.dir);
    const v = await verifyBundle(dir);
    if (!v.ok) throw new PublishBlockedError(`${s.key}: bundle integrity check failed (${v.artifacts.filter((a) => !a.ok).map((a) => `${a.path}: ${a.reason}`).join(', ') || 'manifest hash'})`);
    for (const f of ['trace.zip', 'console.json', 'network.json']) {
      const found = await scanForSecrets(join(dir, f), scanner);
      if (found.length) throw new PublishBlockedError(`${s.key}/${f}: scrubber found ${found.length} secret-like value(s) (${[...new Set(found.map((x) => x.name))].join(', ')}); refusing to publish`);
    }
  }
  const prefix = runPrefix({ repo: o.repo, pr: o.pr, branch: summary.git.branch, sha: summary.git.sha, runId: summary.runId });
  let uploaded = 0;
  let skipped = 0;
  const files = (await walk(runDir)).sort((a, b) => (a.endsWith('run.json') ? 1 : b.endsWith('run.json') ? -1 : 0)); // run.json last = commit marker
  for (const f of files) {
    const rel = relative(runDir, f).split(sep).join('/');
    const r = await store.put(prefix + rel, f, { contentType: contentTypeFor(f), sha256: await sha256File(f) });
    r === 'uploaded' ? uploaded++ : skipped++;
  }
  return { prefix, uploaded, skipped, summary };
}
