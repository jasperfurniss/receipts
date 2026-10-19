import { createReadStream, existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { ArtifactStore, ByteRange, StoredObject } from './index.js';
import { safeKey } from './index.js';
import { contentTypeFor } from '../manifest.js';

export class FsStore implements ArtifactStore {
  readonly kind = 'fs' as const;
  readonly dir: string;
  constructor(dir: string, root: string) {
    this.dir = resolve(root, dir);
  }
  private path(key: string) {
    const p = resolve(this.dir, safeKey(key));
    if (p !== this.dir && !p.startsWith(this.dir + sep)) throw new Error('key escapes store');
    return p;
  }
  async put(key: string, file: string, opts: { contentType: string; sha256: string }) {
    const p = this.path(key);
    const metaP = p + '.sha256';
    if (existsSync(p) && existsSync(metaP) && (await readFile(metaP, 'utf8')).trim() === opts.sha256) return 'skipped' as const;
    await mkdir(dirname(p), { recursive: true });
    await copyFile(file, p);
    await writeFile(metaP, opts.sha256);
    return 'uploaded' as const;
  }
  async putBuffer(key: string, body: Buffer) {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, body);
  }
  async get(key: string, range?: ByteRange): Promise<StoredObject | undefined> {
    const p = this.path(key);
    try {
      const s = await stat(p);
      if (!s.isFile()) return undefined;
      if (range && s.size > 0) {
        const end = Math.min(range.end ?? s.size - 1, s.size - 1);
        return { stream: createReadStream(p, { start: range.start, end }), contentType: contentTypeFor(p), size: s.size, range: { start: range.start, end } };
      }
      return { stream: createReadStream(p), contentType: contentTypeFor(p), size: s.size };
    } catch {
      return undefined;
    }
  }
  async getText(key: string) {
    try {
      return await readFile(this.path(key), 'utf8');
    } catch {
      return undefined;
    }
  }
  async list(prefix: string): Promise<string[]> {
    const out: string[] = [];
    const walk = async (d: string) => {
      let entries;
      try {
        entries = await readdir(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = join(d, e.name);
        if (e.isDirectory()) await walk(p);
        else if (!e.name.endsWith('.sha256')) out.push(relative(this.dir, p).split(sep).join('/'));
      }
    };
    await walk(this.dir);
    return out.filter((k) => k.startsWith(prefix)).sort();
  }
  async deletePrefix(prefix: string) {
    const keys = await this.list(prefix);
    for (const k of keys) {
      await rm(this.path(k), { force: true });
      await rm(this.path(k) + '.sha256', { force: true });
    }
    return keys.length;
  }
}
