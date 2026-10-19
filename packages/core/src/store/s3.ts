import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { StoreConfig } from '../config.js';
import type { ArtifactStore, ByteRange, StoredObject } from './index.js';
import { safeKey } from './index.js';

type S3Cfg = Extract<StoreConfig, { type: 's3' }>;

export class S3Store implements ArtifactStore {
  readonly kind = 's3' as const;
  readonly client: S3Client;
  readonly bucket: string;
  readonly prefix: string;

  constructor(cfg: S3Cfg, client?: S3Client) {
    this.bucket = cfg.bucket;
    this.prefix = cfg.prefix ? cfg.prefix.replace(/\/?$/, '/') : '';
    const id = cfg.accessKeyIdEnv ? process.env[cfg.accessKeyIdEnv] : undefined;
    const secret = cfg.secretAccessKeyEnv ? process.env[cfg.secretAccessKeyEnv] : undefined;
    this.client =
      client ??
      new S3Client({
        region: cfg.region ?? 'us-east-1',
        endpoint: cfg.endpoint,
        forcePathStyle: cfg.forcePathStyle ?? !!cfg.endpoint,
        // Without explicit env names the SDK default chain is used (OIDC web identity in CI, SSO locally).
        credentials: id && secret ? { accessKeyId: id, secretAccessKey: secret } : undefined,
      });
  }
  private k(key: string) {
    return this.prefix + safeKey(key);
  }
  async put(key: string, file: string, opts: { contentType: string; sha256: string }) {
    try {
      const head = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.k(key) }));
      if (head.Metadata?.sha256 === opts.sha256) return 'skipped' as const;
    } catch {
      /* not found */
    }
    const size = (await stat(file)).size;
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.k(key),
        Body: createReadStream(file),
        ContentLength: size,
        ContentType: opts.contentType,
        Metadata: { sha256: opts.sha256 },
      }),
    );
    return 'uploaded' as const;
  }
  async putBuffer(key: string, body: Buffer, contentType: string) {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: this.k(key), Body: body, ContentType: contentType }));
  }
  async get(key: string, range?: ByteRange): Promise<StoredObject | undefined> {
    try {
      const r = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.k(key), Range: range ? `bytes=${range.start}-${range.end ?? ''}` : undefined }),
      );
      const m = /bytes (\d+)-(\d+)\/(\d+)/.exec(r.ContentRange ?? '');
      if (m) return { stream: r.Body as Readable, contentType: r.ContentType ?? 'application/octet-stream', size: Number(m[3]), range: { start: Number(m[1]), end: Number(m[2]) } };
      return { stream: r.Body as Readable, contentType: r.ContentType ?? 'application/octet-stream', size: r.ContentLength };
    } catch {
      return undefined;
    }
  }
  async getText(key: string) {
    try {
      const r = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.k(key) }));
      return await r.Body!.transformToString();
    } catch {
      return undefined;
    }
  }
  async list(prefix: string): Promise<string[]> {
    const out: string[] = [];
    let token: string | undefined;
    do {
      const r = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: this.prefix + prefix, ContinuationToken: token }));
      for (const o of r.Contents ?? []) if (o.Key) out.push(o.Key.slice(this.prefix.length));
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    return out.sort();
  }
  async presign(key: string, ttlSeconds = 600) {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: this.k(key) }), { expiresIn: ttlSeconds });
  }
  async deletePrefix(prefix: string) {
    const keys = await this.list(prefix);
    for (let i = 0; i < keys.length; i += 1000) {
      const chunk = keys.slice(i, i + 1000);
      await this.client.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: chunk.map((k) => ({ Key: this.prefix + k })) } }));
    }
    return keys.length;
  }
}
