/**
 * URL glob compatible with Playwright's conventions: `**` matches anything (including `/`),
 * `*` matches anything except `/`, `?` is literal-ish (single char). A pattern without a scheme
 * is matched against the URL path+query, and also against the full URL.
 * A pattern wrapped in slashes (`/re/flags`) is a regex.
 */
export function globToRegExp(glob: string): RegExp {
  const re = parseRegexLiteral(glob);
  if (re) return re;
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i++;
      } else out += '[^/]*';
    } else if (c === '?') out += '.';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + out + '$');
}

export function parseRegexLiteral(s: string): RegExp | undefined {
  const m = /^\/(.+)\/([gimsuy]*)$/s.exec(s);
  if (!m) return undefined;
  try {
    return new RegExp(m[1]!, m[2]!.replace('g', ''));
  } catch {
    return undefined;
  }
}

export function urlMatches(pattern: string, url: string, baseURL?: string): boolean {
  const re = globToRegExp(pattern);
  if (re.test(url)) return true;
  try {
    const u = new URL(url);
    if (re.test(u.pathname + u.search) || re.test(u.pathname)) return true;
    if (baseURL && !/^[a-z]+:/i.test(pattern)) {
      const full = globToRegExp(new URL(pattern, baseURL).toString().replace(/%2A/g, '*'));
      return full.test(url);
    }
  } catch {
    /* not a URL */
  }
  return false;
}

/** Hostname allowlist check (`localhost`, `*.internal`). */
export function hostAllowed(url: string, allow: string[]): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  return allow.some((a) => {
    if (a.startsWith('*.')) return host.endsWith(a.slice(1)) || host === a.slice(2);
    return host === a;
  });
}

export const DEFAULT_ALLOW_HOSTS = ['localhost', '127.0.0.1', '[::1]', '*.localhost', '*.local', '*.internal', '*.test'];

/** Compare a count against `3`, `>=1`, `<2`, `==0`. */
export function checkTimes(spec: number | string | undefined, actual: number): boolean {
  if (spec === undefined) return actual >= 1;
  if (typeof spec === 'number') return actual === spec;
  const m = /^(>=|<=|>|<|==|=)?\s*(\d+)$/.exec(spec.trim());
  if (!m) return false;
  const n = Number(m[2]);
  switch (m[1]) {
    case '>=': return actual >= n;
    case '<=': return actual <= n;
    case '>': return actual > n;
    case '<': return actual < n;
    default: return actual === n;
  }
}
