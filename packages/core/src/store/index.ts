import type { Readable } from 'node:stream';
import type { StoreConfig } from '../config.js';
import { FsStore } from './fs.js';
import { S3Store } from './s3.js';

export interface ByteRange {
  start: number;
  end?: number;
}
export interface StoredObject {
  stream: Readable;
  contentType: string;
  /** Total object size in bytes. */
  size?: number;
  /** Set when a range was served: inclusive byte offsets. */
  range?: { start: number; end: number };
}

export interface ArtifactStore {
  readonly kind: 'fs' | 's3';
  /** Upload a file. Skips when an object with the same sha256 already exists (content-addressed). */
  put(key: string, file: string, opts: { contentType: string; sha256: string }): Promise<'uploaded' | 'skipped'>;
  putBuffer(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string, range?: ByteRange): Promise<StoredObject | undefined>;
  getText(key: string): Promise<string | undefined>;
  list(prefix: string): Promise<string[]>;
  /** Short-lived signed URL (S3 only). */
  presign?(key: string, ttlSeconds: number): Promise<string>;
  deletePrefix(prefix: string): Promise<number>;
}

export function createStore(cfg: StoreConfig, root: string): ArtifactStore {
  if (cfg.type === 'fs') return new FsStore(cfg.dir, root);
  return new S3Store(cfg);
}

/** `org/repo/pr-<n>/<sha>/<run-id>/` per the spec; falls back to `branch-<name>` or `local`. */
export function runPrefix(o: { repo?: string; pr?: number; branch?: string; sha: string; runId: string }): string {
  const repo = (o.repo ?? 'local/repo').replace(/[^A-Za-z0-9._/-]/g, '-');
  const scope = o.pr ? `pr-${o.pr}` : o.branch ? `branch-${o.branch.replace(/[^A-Za-z0-9._-]/g, '-')}` : 'local';
  return `${repo}/${scope}/${o.sha}/${o.runId}/`;
}

export function safeKey(key: string): string {
  const k = key.replace(/^\/+/, '');
  if (k.split('/').some((p) => p === '..' || p === '.')) throw new Error('invalid key');
  return k;
}
