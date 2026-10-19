import { readFile, writeFile } from 'node:fs/promises';
import JSZip from 'jszip';
import { urlMatches } from './glob.js';

export const ALWAYS_STRIP_HEADERS = [
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'x-csrf-token',
  'x-xsrf-token',
];

export const DEFAULT_SECRET_PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'jwt', re: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}/g },
  { name: 'stripe', re: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{10,}/g },
  { name: 'openai', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g },
  { name: 'github', re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g },
  { name: 'aws-key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'slack', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { name: 'bearer', re: /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/g },
  { name: 'url-token', re: /([?&](?:access_token|refresh_token|id_token|token|api_key|apikey|session|sessionid|code|signature|X-Amz-Signature)=)[^&#\s"'<>]+/gi },
];

export const REDACTED = '[REDACTED]';

export interface ScrubStats {
  headersStripped: number;
  secretsReplaced: number;
  bodiesDropped: number;
  filesScanned: number;
  byPattern: Record<string, number>;
}
export function emptyStats(): ScrubStats {
  return { headersStripped: 0, secretsReplaced: 0, bodiesDropped: 0, filesScanned: 0, byPattern: {} };
}

export interface ScrubberOptions {
  headers?: string[];
  patterns?: string[];
  /** Exact secret values known at runtime (session cookie values, tokens). */
  literals?: string[];
}

export class Scrubber {
  readonly headers: Set<string>;
  readonly patterns: { name: string; re: RegExp }[];
  literals: string[];
  stats = emptyStats();

  constructor(opts: ScrubberOptions = {}) {
    this.headers = new Set([...ALWAYS_STRIP_HEADERS, ...(opts.headers ?? []).map((h) => h.toLowerCase())]);
    this.patterns = [
      ...DEFAULT_SECRET_PATTERNS,
      ...(opts.patterns ?? []).map((p, i) => ({ name: `custom-${i}`, re: new RegExp(p, 'g') })),
    ];
    this.literals = [];
    this.addLiterals(opts.literals ?? []);
  }

  addLiterals(values: string[]) {
    for (const v of values) {
      // Very short values (e.g. "1", "on") would shred unrelated text.
      if (v && v.length >= 8 && !this.literals.includes(v)) this.literals.push(v);
      try {
        const dec = decodeURIComponent(v);
        if (dec !== v && dec.length >= 8 && !this.literals.includes(dec)) this.literals.push(dec);
      } catch {
        /* ignore */
      }
    }
    this.literals.sort((a, b) => b.length - a.length);
  }

  private bump(name: string, n = 1) {
    this.stats.secretsReplaced += n;
    this.stats.byPattern[name] = (this.stats.byPattern[name] ?? 0) + n;
  }

  scrubText(s: string): string {
    let out = s;
    for (const lit of this.literals) {
      if (out.includes(lit)) {
        const parts = out.split(lit);
        this.bump('literal', parts.length - 1);
        out = parts.join(REDACTED);
      }
    }
    for (const { name, re } of this.patterns) {
      re.lastIndex = 0;
      out = out.replace(re, (m, prefix?: string) => {
        this.bump(name);
        return name === 'url-token' && typeof prefix === 'string' ? prefix + REDACTED : REDACTED;
      });
    }
    return out;
  }

  /** Find secrets without modifying (used as a publish-time gate). */
  findSecrets(s: string): { name: string; sample: string }[] {
    const found: { name: string; sample: string }[] = [];
    for (const lit of this.literals) if (s.includes(lit)) found.push({ name: 'literal', sample: lit.slice(0, 4) + '…' });
    for (const { name, re } of this.patterns) {
      re.lastIndex = 0;
      for (const m of s.matchAll(re)) {
        if (name === 'url-token' && m[0].endsWith(REDACTED)) continue;
        if (m[0].includes(REDACTED)) continue;
        found.push({ name, sample: m[0].slice(0, 6) + '…' });
      }
    }
    return found;
  }

  isSensitiveHeader(name: string) {
    return this.headers.has(name.toLowerCase());
  }

  /** Deep-scrub a JSON value: sensitive header values, cookie arrays, then string patterns. */
  scrubValue(v: unknown, keyHint?: string): unknown {
    if (typeof v === 'string') {
      if (keyHint && this.isSensitiveHeader(keyHint)) {
        this.stats.headersStripped++;
        return REDACTED;
      }
      return this.scrubText(v);
    }
    if (Array.isArray(v)) {
      if (keyHint === 'cookies') {
        return v.map((c) => {
          if (c && typeof c === 'object' && 'value' in c) {
            this.stats.headersStripped++;
            return { ...(c as object), value: REDACTED };
          }
          return this.scrubValue(c);
        });
      }
      return v.map((x) => this.scrubValue(x));
    }
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      // {name: 'Cookie', value: '...'} header pairs (HAR / trace format)
      if (typeof o.name === 'string' && typeof o.value === 'string' && Object.keys(o).length <= 3 && this.isSensitiveHeader(o.name)) {
        this.stats.headersStripped++;
        return { ...o, value: REDACTED };
      }
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(o)) out[k] = this.scrubValue(val, k);
      return out;
    }
    return v;
  }

  scrubJsonLines(text: string): string {
    return text
      .split('\n')
      .map((line) => {
        if (!line.trim()) return line;
        try {
          return JSON.stringify(this.scrubValue(JSON.parse(line)));
        } catch {
          return this.scrubText(line);
        }
      })
      .join('\n');
  }
}

function looksText(buf: Uint8Array): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return false;
  return true;
}

/**
 * Scrub a Playwright trace.zip in place: strip sensitive headers/cookies from network events,
 * regex/literal-scrub every text entry, and drop response bodies for configured URL globs.
 */
export async function scrubTraceZip(
  path: string,
  scrubber: Scrubber,
  opts: { dropBodiesFor?: string[]; /** Drop audio/video bodies and anything bigger than this (bytes). Default 1 MiB; 0 disables. */ maxBodyBytes?: number } = {},
): Promise<ScrubStats> {
  const zip = await JSZip.loadAsync(await readFile(path));
  const dropSha = new Set<string>();
  const names = Object.keys(zip.files).filter((n) => !zip.files[n]!.dir);
  // First pass: event streams.
  for (const name of names) {
    if (!/\.(trace|network|stacks|jsonl?)$/.test(name)) continue;
    let text = await zip.file(name)!.async('string');
    const maxBody = opts.maxBodyBytes ?? 1024 * 1024;
    if (name.endsWith('.network')) {
      text = text
        .split('\n')
        .map((line) => {
          if (!line.trim()) return line;
          try {
            const ev = JSON.parse(line);
            const url: string | undefined = ev?.snapshot?.request?.url;
            const content = ev?.snapshot?.response?.content;
            const mime: string = content?.mimeType ?? '';
            const big = maxBody > 0 && (/^(video|audio)\//.test(mime) || (content?.size ?? 0) > maxBody);
            // Playwright has used both `_sha1` (name under resources/) and `_file` (full zip path).
            const ref: string | undefined = content?._file ?? (content?._sha1 ? `resources/${content._sha1}` : undefined);
            if (url && ref && (big || opts.dropBodiesFor?.some((g) => urlMatches(g, url)))) {
              dropSha.add(ref);
              delete content._sha1;
              delete content._file;
              content.text = big ? '[large/media body omitted by receipts]' : '[body dropped by receipts]';
              scrubber.stats.bodiesDropped++;
              return JSON.stringify(ev);
            }
          } catch {
            /* fallthrough */
          }
          return line;
        })
        .join('\n');
    }
    zip.file(name, scrubber.scrubJsonLines(text));
    scrubber.stats.filesScanned++;
  }
  // Second pass: resources (response bodies, sources). Images are left alone.
  for (const name of names) {
    if (!name.startsWith('resources/')) continue;
    if (dropSha.has(name)) {
      zip.remove(name);
      continue;
    }
    if (/\.(png|jpe?g|webp|gif|woff2?|ttf|webm|mp4)$/i.test(name)) continue;
    const buf = await zip.file(name)!.async('uint8array');
    if (!looksText(buf)) continue;
    const text = Buffer.from(buf).toString('utf8');
    const out = scrubber.scrubText(text);
    if (out !== text) zip.file(name, out);
    scrubber.stats.filesScanned++;
  }
  const outBuf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  await writeFile(path, outBuf);
  return scrubber.stats;
}

/** Scan a trace.zip (or any text file) for residual secrets. */
export async function scanForSecrets(path: string, scrubber: Scrubber): Promise<{ file: string; name: string; sample: string }[]> {
  const buf = await readFile(path);
  const found: { file: string; name: string; sample: string }[] = [];
  if (path.endsWith('.zip')) {
    const zip = await JSZip.loadAsync(buf);
    for (const name of Object.keys(zip.files)) {
      if (zip.files[name]!.dir || /\.(png|jpe?g|webp|gif|woff2?|ttf)$/i.test(name)) continue;
      const b = await zip.file(name)!.async('uint8array');
      if (!looksText(b)) continue;
      for (const f of scrubber.findSecrets(Buffer.from(b).toString('utf8'))) found.push({ file: name, ...f });
    }
  } else if (looksText(buf)) {
    for (const f of scrubber.findSecrets(buf.toString('utf8'))) found.push({ file: path, ...f });
  }
  return found;
}
