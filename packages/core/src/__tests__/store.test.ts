import { describe, expect, it, beforeAll } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CreateBucketCommand } from '@aws-sdk/client-s3';
import { FsStore } from '../store/fs.js';
import { S3Store } from '../store/s3.js';
import { runPrefix, safeKey, type ArtifactStore } from '../store/index.js';
import { sha256 } from '../hash.js';

async function text(store: ArtifactStore, key: string, range?: { start: number; end?: number }) {
  const o = await store.get(key, range);
  if (!o) return undefined;
  const chunks: Buffer[] = [];
  for await (const c of o.stream) chunks.push(Buffer.from(c));
  return { body: Buffer.concat(chunks).toString(), o };
}

async function exercise(store: ArtifactStore) {
  const dir = mkdtempSync(join(tmpdir(), 'rcpt-s-'));
  const f = join(dir, 'video.mp4');
  writeFileSync(f, '0123456789');
  const prefix = runPrefix({ repo: 'acme/web', pr: 12, sha: 'abc', runId: 'r1' });
  expect(prefix).toBe('acme/web/pr-12/abc/r1/');
  expect(await store.put(prefix + 'video.mp4', f, { contentType: 'video/mp4', sha256: sha256('0123456789') })).toBe('uploaded');
  expect(await store.put(prefix + 'video.mp4', f, { contentType: 'video/mp4', sha256: sha256('0123456789') })).toBe('skipped');
  await store.putBuffer(prefix + 'run.json', Buffer.from('{"a":1}'), 'application/json');
  expect(await store.getText(prefix + 'run.json')).toBe('{"a":1}');
  const full = await text(store, prefix + 'video.mp4');
  expect(full!.body).toBe('0123456789');
  expect(full!.o.size).toBe(10);
  const part = await text(store, prefix + 'video.mp4', { start: 2, end: 5 });
  expect(part!.body).toBe('2345');
  expect(part!.o.range).toEqual({ start: 2, end: 5 });
  expect(await store.list('acme/web/pr-12/')).toEqual([prefix + 'run.json', prefix + 'video.mp4']);
  expect(await store.get(prefix + 'missing')).toBeUndefined();
  expect(await store.deletePrefix('acme/web/pr-12/')).toBe(2);
  expect(await store.list('acme/')).toEqual([]);
}

describe('artifact stores', () => {
  it('fs store: content-addressed put, range get, list, delete', async () => {
    await exercise(new FsStore(mkdtempSync(join(tmpdir(), 'rcpt-fs-')), '/'));
  });

  it('rejects path traversal', () => {
    expect(() => safeKey('a/../../etc/passwd')).toThrow();
    const s = new FsStore('/tmp/x', '/');
    return expect(s.getText('../etc/passwd')).resolves.toBeUndefined();
  });

  describe('s3 store (S3-compatible endpoint)', () => {
    const endpoint = process.env.RECEIPTS_TEST_S3_ENDPOINT ?? 'http://127.0.0.1:5055';
    let up = false;
    beforeAll(async () => {
      try {
        up = (await fetch(endpoint, { signal: AbortSignal.timeout(1500) })).status < 500;
      } catch {
        up = false;
      }
    });
    it('round-trips against a local S3-compatible server (moto) + presigns', async (ctx) => {
      if (!up) return ctx.skip();
      process.env.TEST_S3_KEY = 'test';
      process.env.TEST_S3_SECRET = 'test';
      const store = new S3Store({ type: 's3', bucket: 'receipts-test', endpoint, region: 'us-east-1', prefix: 'evidence', accessKeyIdEnv: 'TEST_S3_KEY', secretAccessKeyEnv: 'TEST_S3_SECRET' });
      await store.client.send(new CreateBucketCommand({ Bucket: 'receipts-test' })).catch(() => {});
      await exercise(store);
      await store.putBuffer('k/x.png', Buffer.from('png'), 'image/png');
      const url = await store.presign('k/x.png', 600);
      expect(url).toContain('X-Amz-Expires=600');
      expect(url).toContain('/receipts-test/evidence/k/x.png');
      expect(await (await fetch(url)).text()).toBe('png');
    });
  });
});
