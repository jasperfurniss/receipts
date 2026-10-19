import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishRun, PublishBlockedError } from '../publish.js';
import { FsStore } from '../store/fs.js';
import { artifactRecord, sealManifest, type Manifest } from '../manifest.js';

async function fakeRun(consoleText: string) {
  const runDir = mkdtempSync(join(tmpdir(), 'rcpt-p-'));
  const d = join(runDir, 's1');
  mkdirSync(d);
  writeFileSync(join(d, 'console.json'), consoleText);
  writeFileSync(join(d, 'network.json'), '[]');
  const JSZip = (await import('jszip')).default;
  const z = new JSZip();
  z.file('trace.trace', '{}');
  writeFileSync(join(d, 'trace.zip'), await z.generateAsync({ type: 'nodebuffer' }));
  const m = sealManifest({
    key: 's1', git: { sha: 'abc', shortSha: 'abc', dirty: false, branch: 'main' },
    artifacts: [await artifactRecord(d, 'console.json', 'log'), await artifactRecord(d, 'network.json', 'log'), await artifactRecord(d, 'trace.zip', 'trace')],
  } as unknown as Manifest);
  writeFileSync(join(d, 'manifest.json'), JSON.stringify(m));
  writeFileSync(join(runDir, 'run.json'), JSON.stringify({ runId: 'r1', git: m.git, scenarios: [{ key: 's1', dir: 's1' }] }));
  return runDir;
}

describe('publish gate (local temp store only)', () => {
  it('uploads a clean bundle under org/repo/pr-n/sha/run and skips unchanged files on re-upload', async () => {
    const run = await fakeRun('[]');
    const store = new FsStore(mkdtempSync(join(tmpdir(), 'rcpt-ps-')), '/');
    const a = await publishRun(run, store, { repo: 'acme/web', pr: 7 });
    expect(a.prefix).toBe('acme/web/pr-7/abc/r1/');
    expect(a.uploaded).toBe(5);
    const b = await publishRun(run, store, { repo: 'acme/web', pr: 7 });
    expect(b).toMatchObject({ uploaded: 0, skipped: 5 });
  });

  it('refuses to publish when a secret pattern survives scrubbing', async () => {
    const run = await fakeRun(JSON.stringify([{ text: 'leaked ghp_' + 'x'.repeat(36) }]));
    const store = new FsStore(mkdtempSync(join(tmpdir(), 'rcpt-ps-')), '/');
    await expect(publishRun(run, store, {})).rejects.toThrow(PublishBlockedError);
    expect(await store.list('')).toEqual([]);
  });

  it('refuses to publish a tampered bundle', async () => {
    const run = await fakeRun('[]');
    writeFileSync(join(run, 's1', 'network.json'), '[{"changed":true}]');
    await expect(publishRun(run, new FsStore(mkdtempSync(join(tmpdir(), 'rcpt-ps-')), '/'), {})).rejects.toThrow(/integrity/);
  });
});
