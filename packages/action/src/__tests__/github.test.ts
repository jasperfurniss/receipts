import { describe, expect, it } from 'vitest';
import { STICKY_MARKER } from '@receipts/core';
import { GitHubClient } from '../github.js';

function mockFetch(existing: { id: number; body: string }[]) {
  const calls: { method: string; url: string; body?: any }[] = [];
  const f = (async (url: string, init: any) => {
    calls.push({ method: init.method, url, body: init.body ? JSON.parse(init.body) : undefined });
    if (init.method === 'GET') return new Response(JSON.stringify(existing), { status: 200 });
    return new Response(JSON.stringify({ id: 99 }), { status: 201 });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe('GitHub client (mocked; never hits the network)', () => {
  it('creates the sticky comment once, then edits it in place', async () => {
    const a = mockFetch([{ id: 1, body: 'unrelated' }]);
    expect(await new GitHubClient('t', 'acme/web', 'https://api.test', a.f).upsertComment(5, `${STICKY_MARKER}\nhi`)).toEqual({ id: 99, created: true });
    expect(a.calls.map((c) => `${c.method} ${c.url}`)).toEqual(['GET https://api.test/repos/acme/web/issues/5/comments?per_page=100&page=1', 'POST https://api.test/repos/acme/web/issues/5/comments']);
    const b = mockFetch([{ id: 7, body: `${STICKY_MARKER}\nold` }]);
    expect(await new GitHubClient('t', 'acme/web', 'https://api.test', b.f).upsertComment(5, `${STICKY_MARKER}\nnew`)).toEqual({ id: 7, created: false });
    expect(b.calls[1]).toMatchObject({ method: 'PATCH', url: 'https://api.test/repos/acme/web/issues/comments/7' });
  });

  it('creates a completed receipts/evidence check run and marks stale', async () => {
    const m = mockFetch([{ id: 7, body: `${STICKY_MARKER}\n### 🧾 Receipts: 1/1` }]);
    const gh = new GitHubClient('t', 'acme/web', 'https://api.test', m.f);
    await gh.createCheck('abc', { name: 'receipts/evidence', conclusion: 'success', title: 'ok', summary: 's' });
    expect(m.calls[0]!.body).toMatchObject({ name: 'receipts/evidence', head_sha: 'abc', status: 'completed', conclusion: 'success' });
    await gh.markStale(5, 'def4567890');
    expect(m.calls.at(-1)!.body.body).toContain('⏳ Receipts: stale (head is `def4567`)');
  });
});
