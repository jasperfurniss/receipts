import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export type AuthConfig =
  | { mode: 'none' }
  | { mode: 'token'; token: string }
  | {
      /** Trust an identity header set by oauth2-proxy / Cloudflare Access / an internal gateway. */
      mode: 'header';
      header?: string; // default x-forwarded-email (oauth2-proxy also sends x-auth-request-email)
      groupsHeader?: string; // default x-forwarded-groups
      allowedDomains?: string[];
      allowedEmails?: string[];
      /** e.g. GitHub org/team from oauth2-proxy; any match grants access. */
      allowedGroups?: string[];
      /** Remote addresses allowed to set the header. Default: loopback only (proxy on the same host/pod). */
      trustedProxies?: string[];
    };

export interface AuthResult {
  ok: boolean;
  user?: string;
  status?: number;
  reason?: string;
  setCookie?: string;
}

export const TOKEN_COOKIE = 'receipts_token';

function safeEq(a: string, b: string) {
  const A = Buffer.from(a);
  const B = Buffer.from(b);
  return A.length === B.length && timingSafeEqual(A, B);
}

function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of (req.headers.cookie ?? '').split(';')) {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  }
  return out;
}

const LOOPBACK = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];

export function authenticate(req: IncomingMessage, cfg: AuthConfig, url: URL): AuthResult {
  if (cfg.mode === 'none') return { ok: true, user: 'local' };
  if (cfg.mode === 'token') {
    const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1];
    const fromCookie = cookies(req)[TOKEN_COOKIE];
    const fromQuery = url.pathname === '/login' ? url.searchParams.get('token') ?? undefined : undefined;
    const presented = bearer ?? fromQuery ?? fromCookie;
    if (!presented || !safeEq(presented, cfg.token)) return { ok: false, status: 401, reason: 'missing or invalid token' };
    return {
      ok: true,
      user: 'token-user',
      setCookie: fromQuery ? `${TOKEN_COOKIE}=${encodeURIComponent(presented)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200` : undefined,
    };
  }
  const remote = req.socket.remoteAddress ?? '';
  const trusted = cfg.trustedProxies ?? LOOPBACK;
  if (!trusted.includes(remote)) return { ok: false, status: 403, reason: `request did not come through a trusted proxy (${remote})` };
  const email = String(req.headers[(cfg.header ?? 'x-forwarded-email').toLowerCase()] ?? req.headers['x-auth-request-email'] ?? '').trim().toLowerCase();
  if (!email) return { ok: false, status: 401, reason: 'no identity header (is oauth2-proxy in front?)' };
  const groups = String(req.headers[(cfg.groupsHeader ?? 'x-forwarded-groups').toLowerCase()] ?? '')
    .split(',')
    .map((g) => g.trim())
    .filter(Boolean);
  const anyRule = !!(cfg.allowedDomains?.length || cfg.allowedEmails?.length || cfg.allowedGroups?.length);
  const allowed =
    !anyRule ||
    cfg.allowedEmails?.map((e) => e.toLowerCase()).includes(email) ||
    cfg.allowedDomains?.some((d) => email.endsWith('@' + d.toLowerCase())) ||
    cfg.allowedGroups?.some((g) => groups.includes(g));
  if (!allowed) return { ok: false, status: 403, reason: `${email} is not allowed` };
  return { ok: true, user: email };
}
