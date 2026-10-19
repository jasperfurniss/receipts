import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { FsStore } from '@receipts/core';
import { createViewer } from '../server.js';
import { authenticate } from '../auth.js';

const root = mkdtempSync(join(tmpdir(), 'rcpt-v-'));
const runDir = join(root, 'acme/web/pr-1/abc/r1');
mkdirSync(join(runDir, 's1'), { recursive: true });
writeFileSync(join(runDir, 'run.json'), JSON.stringify({ schema: 'receipts.run/v1', runId: 'r1', createdAt: new Date().toISOString(), git: { sha: 'abc', shortSha: 'abc', dirty: false }, baseURL: '', browser: 'chromium', durationMs: 1, scenarios: [], totals: { passed: 0, failed: 0 } }));
writeFileSync(join(runDir, 's1', 'video.mp4'), '0123456789');
const store = new FsStore(root, '/');
const servers: any[] = [];
async function start(auth: any) {
  const audit = join(root, 'audit.log');
  const s = createViewer({ store, auth, auditLog: audit });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  servers.push(s);
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}
afterAll(() => servers.forEach((s) => s.close()));

describe('viewer', () => {
  it('token mode: rejects without token, accepts bearer, login sets HttpOnly cookie', async () => {
    const base = await start({ mode: 'token', token: 'x'.repeat(24) });
    expect((await fetch(base + '/')).status).toBe(401);
    expect((await fetch(base + '/', { headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
    const ok = await fetch(base + '/', { headers: { authorization: `Bearer ${'x'.repeat(24)}` } });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain('r1');
    const login = await fetch(base + `/login?token=${'x'.repeat(24)}`, { redirect: 'manual' });
    expect(login.status).toBe(302);
    const cookie = login.headers.get('set-cookie')!;
    expect(cookie).toMatch(/receipts_token=.*HttpOnly; SameSite=Strict/);
    expect((await fetch(base + '/', { headers: { cookie: cookie.split(';')[0]! } })).status).toBe(200);
    // ?token= only works on /login, so tokens don't end up in shared links
    expect((await fetch(base + `/?token=${'x'.repeat(24)}`)).status).toBe(401);
  });

  it('serves byte ranges for video seeking, private cache headers, and blocks traversal', async () => {
    const base = await start({ mode: 'none' });
    const r = await fetch(base + '/a/acme/web/pr-1/abc/r1/s1/video.mp4', { headers: { range: 'bytes=3-5' } });
    expect(r.status).toBe(206);
    expect(r.headers.get('content-range')).toBe('bytes 3-5/10');
    expect(await r.text()).toBe('345');
    expect(r.headers.get('cache-control')).toContain('private');
    expect((await fetch(base + '/a/../../etc/passwd')).status).toBe(404);
    expect((await fetch(base + '/trace/index.html')).status).toBe(200);
    expect((await fetch(base + '/trace/../../package.json')).status).toBe(404);
  });

  it('header mode (oauth2-proxy): needs identity from a trusted proxy and an allowed domain/group', () => {
    const req = (headers: Record<string, string>, ip = '127.0.0.1') => ({ headers, socket: { remoteAddress: ip } }) as any;
    const u = new URL('http://x/');
    const cfg = { mode: 'header' as const, allowedDomains: ['acme.com'], allowedGroups: ['acme:web-team'] };
    expect(authenticate(req({}), cfg, u).status).toBe(401);
    expect(authenticate(req({ 'x-forwarded-email': 'dev@acme.com' }), cfg, u)).toMatchObject({ ok: true, user: 'dev@acme.com' });
    expect(authenticate(req({ 'x-forwarded-email': 'x@gmail.com' }), cfg, u).status).toBe(403);
    expect(authenticate(req({ 'x-forwarded-email': 'x@gmail.com', 'x-forwarded-groups': 'acme:web-team' }), cfg, u).ok).toBe(true);
    expect(authenticate(req({ 'x-forwarded-email': 'dev@acme.com' }, '10.0.0.9'), cfg, u).status).toBe(403); // spoofed, not via proxy
  });
});
