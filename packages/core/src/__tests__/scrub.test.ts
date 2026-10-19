import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { Scrubber, scrubTraceZip, scanForSecrets, REDACTED } from '../scrub.js';
import { redactionCss } from '../runner/redact.js';

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1X2FkYSJ9.c2lnbmF0dXJlLW5vdC1yZWFs';

describe('scrubber', () => {
  it('strips known secret patterns and literals from text', () => {
    const s = new Scrubber({ literals: ['sess_0123456789abcdef'] });
    const out = s.scrubText(`token=${JWT} gh=ghp_${'a'.repeat(36)} key=sk_test_${'b'.repeat(24)} c=sess_0123456789abcdef /cb?access_token=abc123&x=1 Authorization: Bearer abc.def.ghi1234`);
    expect(out).not.toMatch(/eyJhbGci|ghp_a|sk_test_b|sess_0123|abc123|abc\.def/);
    expect(out).toContain('access_token=' + REDACTED + '&x=1');
    expect(s.stats.secretsReplaced).toBeGreaterThanOrEqual(5);
  });

  it('ignores short literals so it does not shred normal text', () => {
    const s = new Scrubber({ literals: ['on', '1'] });
    expect(s.scrubText('turn on 1 thing')).toBe('turn on 1 thing');
  });

  it('redacts sensitive headers and cookies in JSON structures', () => {
    const s = new Scrubber({ headers: ['X-Tenant-Secret'] });
    const v = s.scrubValue({
      request: {
        headers: [
          { name: 'Cookie', value: 'acme_session=sess_x' },
          { name: 'Authorization', value: 'Bearer zzzzzzzzzz' },
          { name: 'Accept', value: 'json' },
          { name: 'x-tenant-secret', value: 'shh' },
        ],
        cookies: [{ name: 'acme_session', value: 'sess_x' }],
      },
      headers: { 'set-cookie': 'a=b', 'content-type': 'json' },
    }) as any;
    expect(v.request.headers.map((h: any) => h.value)).toEqual([REDACTED, REDACTED, 'json', REDACTED]);
    expect(v.request.cookies[0].value).toBe(REDACTED);
    expect(v.headers['set-cookie']).toBe(REDACTED);
    expect(v.headers['content-type']).toBe('json');
  });

  it('scrubs a Playwright-style trace.zip in place and drops configured bodies', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rcpt-'));
    const zip = new JSZip();
    const net = [
      { type: 'resource-snapshot', snapshot: { request: { url: 'http://localhost/api/me', headers: [{ name: 'cookie', value: 'acme_session=sess_aaaaaaaaaaaaaaaa' }] }, response: { headers: [{ name: 'Set-Cookie', value: 'x=y' }], content: { mimeType: 'application/json', _sha1: 'body1.json' } } } },
      { type: 'resource-snapshot', snapshot: { request: { url: 'http://localhost/api/me/profile', headers: [] }, response: { headers: [], content: { mimeType: 'application/json', _sha1: 'body2.json' } } } },
      { type: 'resource-snapshot', snapshot: { request: { url: 'http://localhost/media/a.webm', headers: [] }, response: { headers: [], content: { mimeType: 'video/webm', size: 5, _file: 'resources/vid.webm' } } } },
    ];
    zip.file('trace.network', net.map((n) => JSON.stringify(n)).join('\n'));
    zip.file('trace.trace', JSON.stringify({ type: 'frame-snapshot', html: ['<span>Ada Lovelace</span>'] }) + '\n');
    zip.file('resources/body1.json', JSON.stringify({ apiToken: JWT }));
    zip.file('resources/body2.json', JSON.stringify({ phone: '+1 555' }));
    zip.file('resources/vid.webm', 'VIDEO');
    const p = join(dir, 'trace.zip');
    writeFileSync(p, await zip.generateAsync({ type: 'nodebuffer' }));

    const s = new Scrubber({ literals: ['sess_aaaaaaaaaaaaaaaa'] });
    s.literals.push('Ada Lovelace'); // PII collected from redacted elements during the run
    const stats = await scrubTraceZip(p, s, { dropBodiesFor: ['**/api/me/profile'] });
    expect(stats.headersStripped).toBeGreaterThanOrEqual(2);
    expect(stats.bodiesDropped).toBe(2);
    const out = await JSZip.loadAsync(readFileSync(p));
    expect(out.file('resources/body2.json')).toBeNull();
    expect(out.file('resources/vid.webm')).toBeNull();
    expect(await out.file('resources/body1.json')!.async('string')).not.toContain('eyJ');
    expect(await out.file('trace.trace')!.async('string')).not.toContain('Ada Lovelace');
    expect(await scanForSecrets(p, s)).toEqual([]);
  });

  it('builds redaction CSS for selectors and the data attribute', () => {
    const css = redactionCss(['.email', '[data-testid=avatar]'], 'data-receipts-redact', 'blur');
    expect(css).toContain('.email,\n[data-testid=avatar],\n[data-receipts-redact] { filter:blur(12px) !important; }');
    expect(redactionCss([], 'data-x', 'solid')).toContain('color:transparent');
  });
});
