import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import {
  esc,
  renderRunPage,
  STYLES,
  traceViewerDir,
  type ArtifactStore,
  type Manifest,
  type RunSummary,
} from '@receipts/core';
import { authenticate, type AuthConfig } from './auth.js';

export interface ViewerOptions {
  store: ArtifactStore;
  auth: AuthConfig;
  /** JSONL audit log of who viewed or downloaded what. */
  auditLog?: string;
  /** Redirect media downloads to short-lived signed URLs (S3 stores only). */
  presign?: boolean;
  title?: string;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
};

function send(res: ServerResponse, status: number, body: string | Buffer, type = 'text/html; charset=utf-8', extra: Record<string, string> = {}) {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'SAMEORIGIN',
    ...extra,
  });
  res.end(body);
}

function page(title: string, body: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>${STYLES}</style></head><body><header class="top"><a class="brand" href="/" style="color:#fff;text-decoration:none">🧾 Receipts</a><span class="meta" style="color:#94a3b8">private viewer</span></header><main>${body}</main></body></html>`;
}

async function readRun(store: ArtifactStore, prefix: string): Promise<{ summary: RunSummary; manifests: Manifest[] } | undefined> {
  const txt = await store.getText(prefix + 'run.json');
  if (!txt) return undefined;
  const summary = JSON.parse(txt) as RunSummary;
  const manifests: Manifest[] = [];
  for (const s of summary.scenarios) {
    const m = await store.getText(`${prefix}${s.dir}/manifest.json`);
    if (m) manifests.push(JSON.parse(m));
  }
  return { summary, manifests };
}

async function shotPng(store: ArtifactStore, key: string): Promise<PNG | undefined> {
  const o = await store.get(key);
  if (!o) return undefined;
  const chunks: Buffer[] = [];
  for await (const c of o.stream) chunks.push(Buffer.from(c));
  return PNG.sync.read(Buffer.concat(chunks));
}

/** Pixel diff of two screenshots (pixelmatch). Returns the diff PNG and mismatch ratio. */
export async function diffShots(store: ArtifactStore, a: string, b: string): Promise<{ png: Buffer; ratio: number } | undefined> {
  const [A, B] = await Promise.all([shotPng(store, a), shotPng(store, b)]);
  if (!A || !B) return undefined;
  const w = Math.min(A.width, B.width);
  const h = Math.min(A.height, B.height);
  const crop = (p: PNG) => {
    if (p.width === w && p.height === h) return p.data;
    const out = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) p.data.copy(out, y * w * 4, y * p.width * 4, y * p.width * 4 + w * 4);
    return out;
  };
  const diff = new PNG({ width: w, height: h });
  const n = pixelmatch(crop(A), crop(B), diff.data, w, h, { threshold: 0.1 });
  return { png: PNG.sync.write(diff), ratio: n / (w * h) };
}

export function createViewer(opts: ViewerOptions): Server {
  const { store } = opts;
  const tvDir = traceViewerDir();
  const audit = async (user: string | undefined, req: IncomingMessage, status: number) => {
    if (!opts.auditLog) return;
    await appendFile(opts.auditLog, JSON.stringify({ ts: new Date().toISOString(), user, method: req.method, path: req.url, status }) + '\n').catch(() => {});
  };

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://viewer.local');
    const path = decodeURIComponent(url.pathname);
    if (path === '/healthz') return send(res, 200, 'ok', 'text/plain');
    const auth = authenticate(req, opts.auth, url);
    if (!auth.ok) {
      await audit(undefined, req, auth.status ?? 401);
      return send(res, auth.status ?? 401, page('Not authorized', `<div class="card"><h1>🔒 Not authorized</h1><p class="meta">${esc(auth.reason)}</p></div>`));
    }
    const extra: Record<string, string> = auth.setCookie ? { 'set-cookie': auth.setCookie } : {};
    try {
      if (path === '/login') {
        res.writeHead(302, { location: '/', ...extra });
        return res.end();
      }
      if (path === '/' || path === '') {
        const keys = (await store.list('')).filter((k) => k.endsWith('/run.json'));
        const runs: { prefix: string; s: RunSummary }[] = [];
        for (const k of keys) {
          const t = await store.getText(k);
          if (t) runs.push({ prefix: k.slice(0, -'run.json'.length), s: JSON.parse(t) });
        }
        runs.sort((a, b) => b.s.createdAt.localeCompare(a.s.createdAt));
        const rows = runs
          .map(({ prefix, s }) => {
            const scope = prefix.split('/').slice(0, 3).join('/');
            return `<tr><td>${s.totals.failed ? '❌' : '✅'}</td><td><a href="/r/${esc(prefix)}">${esc(s.runId)}</a></td><td><code>${esc(scope)}</code></td><td><code>${esc(s.git.shortSha)}</code></td><td>${s.totals.passed}/${s.scenarios.length}</td><td class="meta">${esc(new Date(s.createdAt).toLocaleString())}</td></tr>`;
          })
          .join('');
        await audit(auth.user, req, 200);
        return send(res, 200, page('Receipts runs', `<div class="card"><h1 style="margin-top:0">Runs</h1><p class="meta">Signed in as <code>${esc(auth.user)}</code> · ${runs.length} run(s) · store: ${store.kind}</p><table><tr><th></th><th>Run</th><th>Repo / scope</th><th>SHA</th><th>Passed</th><th>When</th></tr>${rows || '<tr><td colspan=6 class="meta">No runs published yet.</td></tr>'}</table></div>`), undefined, extra);
      }
      if (path.startsWith('/r/')) {
        const prefix = path.slice(3).replace(/\/?$/, '/');
        const run = await readRun(store, prefix);
        if (!run) return send(res, 404, page('Not found', '<div class="card">Run not found</div>'));
        await audit(auth.user, req, 200);
        const html = renderRunPage(run.summary, run.manifests, {
          asset: (dir, rel) => `/a/${prefix}${dir}/${rel}`,
          traceViewer: tvDir ? (dir) => `/trace/index.html?trace=${encodeURIComponent(`${url.protocol}//${req.headers.host}/a/${prefix}${dir}/trace.zip`)}` : undefined,
          nav: `<a href="/">All runs</a>`,
          compareLink: ` · <form style="display:inline" action="/compare"><input type="hidden" name="b" value="${esc(prefix)}"><input name="a" placeholder="base run prefix" style="font-size:12px;width:220px"> <button style="font-size:12px">Compare</button></form>`,
        });
        return send(res, 200, html, undefined, extra);
      }
      if (path.startsWith('/a/')) {
        const key = path.slice(3);
        if (opts.presign && store.presign && /\.(mp4|webm|png)$/.test(key)) {
          await audit(auth.user, req, 302);
          res.writeHead(302, { location: await store.presign(key, 600), 'cache-control': 'no-store' });
          return res.end();
        }
        const rm = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range ?? ''));
        const obj = await store.get(key, rm ? { start: Number(rm[1]), end: rm[2] ? Number(rm[2]) : undefined } : undefined);
        if (!obj) return send(res, 404, 'not found', 'text/plain');
        await audit(auth.user, req, obj.range ? 206 : 200);
        const headers: Record<string, string> = {
          'content-type': obj.contentType,
          'cache-control': 'private, max-age=300',
          'x-content-type-options': 'nosniff',
          'accept-ranges': 'bytes',
          ...extra,
        };
        if (obj.range && obj.size !== undefined) {
          headers['content-range'] = `bytes ${obj.range.start}-${obj.range.end}/${obj.size}`;
          headers['content-length'] = String(obj.range.end - obj.range.start + 1);
          res.writeHead(206, headers);
        } else {
          if (obj.size !== undefined) headers['content-length'] = String(obj.size);
          res.writeHead(200, headers);
        }
        obj.stream.pipe(res);
        return;
      }
      if (path.startsWith('/trace/')) {
        if (!tvDir) return send(res, 404, 'trace viewer not bundled', 'text/plain');
        const rel = normalize(path.slice('/trace/'.length) || 'index.html');
        const file = resolve(tvDir, rel);
        if (!file.startsWith(tvDir + sep) || !existsSync(file) || !statSync(file).isFile()) return send(res, 404, 'not found', 'text/plain');
        res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'private, max-age=3600', ...extra });
        createReadStream(file).pipe(res);
        return;
      }
      if (path === '/compare') {
        const a = (url.searchParams.get('a') ?? '').replace(/\/?$/, '/');
        const b = (url.searchParams.get('b') ?? '').replace(/\/?$/, '/');
        const [A, B] = await Promise.all([readRun(store, a), readRun(store, b)]);
        if (!A || !B) return send(res, 404, page('Compare', '<div class="card">Both runs are required (?a=<base prefix>&b=<head prefix>)</div>'));
        const sections = B.manifests
          .map((mb) => {
            const ma = A.manifests.find((x) => x.key === mb.key);
            const da = A.summary.scenarios.find((s) => s.key === mb.key)?.dir;
            const db = B.summary.scenarios.find((s) => s.key === mb.key)?.dir;
            const rows = mb.steps
              .map((sb) => {
                const sa = ma?.steps.find((x) => x.index === sb.index && x.chapter === sb.chapter) ?? ma?.steps.find((x) => x.chapter === sb.chapter);
                const ka = sa?.screenshot && da ? `${a}${da}/${sa.screenshot.path}` : undefined;
                const kb = sb.screenshot && db ? `${b}${db}/${sb.screenshot.path}` : undefined;
                const img = (k?: string) => (k ? `<img style="width:100%;border:1px solid #e2e8f0;border-radius:6px" src="/a/${esc(k)}">` : '<span class="meta">no capture</span>');
                const diff = ka && kb ? `<img style="width:100%;border:1px solid #e2e8f0;border-radius:6px" src="/diff?a=${encodeURIComponent(ka)}&b=${encodeURIComponent(kb)}">` : '';
                return `<tr><td><strong>${sb.index}. ${esc(sb.chapter)}</strong><br><span class="pill ${sa?.status ?? 'skipped'}">base ${sa?.status ?? '—'}</span> <span class="pill ${sb.status}">head ${sb.status}</span></td><td>${img(ka)}</td><td>${img(kb)}</td><td>${diff}</td></tr>`;
              })
              .join('');
            return `<section class="card"><h2 style="font-size:16px"><code>${esc(mb.key)}</code></h2><table><tr><th style="width:18%">Step</th><th>Base <code>${esc(A.summary.git.shortSha)}</code></th><th>Head <code>${esc(B.summary.git.shortSha)}</code></th><th>Pixel diff</th></tr>${rows}</table></section>`;
          })
          .join('');
        await audit(auth.user, req, 200);
        return send(res, 200, page('Compare', `<div class="card"><h1 style="margin-top:0;font-size:18px">Compare: base vs head, aligned by step</h1></div>${sections}`), undefined, extra);
      }
      if (path === '/diff') {
        const d = await diffShots(store, url.searchParams.get('a') ?? '', url.searchParams.get('b') ?? '');
        if (!d) return send(res, 404, 'not found', 'text/plain');
        return send(res, 200, d.png, 'image/png', { 'x-receipts-mismatch': d.ratio.toFixed(5), ...extra });
      }
      return send(res, 404, page('Not found', '<div class="card">Not found</div>'));
    } catch (e) {
      return send(res, 500, page('Error', `<div class="card"><pre>${esc((e as Error).message)}</pre></div>`));
    }
  });
}

export { join };
