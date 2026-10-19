import type { BrowserContext } from 'playwright';
import type { FlagAdapterConfig, Flags } from '../config.js';

export function encodeFlags(flags: Flags, enc: 'json' | 'csv' | ((f: Flags) => string) = 'json'): string {
  if (typeof enc === 'function') return enc(flags);
  if (enc === 'csv')
    return Object.entries(flags)
      .map(([k, v]) => `${k}:${v === true ? 'on' : v === false ? 'off' : v}`)
      .join(',');
  return JSON.stringify(flags);
}

/** Mutable holder so route/query adapters see mid-scenario `flag:` changes. */
export interface FlagState {
  current: Flags;
}

export class FlagApplier {
  private routesInstalled = false;
  constructor(private adapters: FlagAdapterConfig[], private state: FlagState) {}

  get types() {
    return this.adapters.map((a) => a.type);
  }

  async apply(context: BrowserContext, baseURL: string) {
    const flags = this.state.current;
    if (!Object.keys(flags).length) return;
    for (const a of this.adapters) {
      switch (a.type) {
        case 'cookie': {
          const value = encodeURIComponent(encodeFlags(flags, a.encode));
          await context.addCookies([a.domain ? { name: a.name, value, domain: a.domain, path: '/' } : { name: a.name, value, url: baseURL }]);
          break;
        }
        case 'localStorage': {
          const value = encodeFlags(flags, a.encode);
          // Later init scripts run after earlier ones, so a mid-run flag change wins.
          await context.addInitScript(
            ([k, v]) => {
              try { localStorage.setItem(k, v); } catch { /* opaque origin */ }
            },
            [a.key, value] as const,
          );
          break;
        }
        case 'header':
          await context.setExtraHTTPHeaders({ [a.name]: encodeFlags(flags, a.encode) });
          break;
        case 'route':
          if (!this.routesInstalled) {
            await context.route(a.url, async (route) => {
              const res = await route.fetch();
              let body: any;
              try {
                body = await res.json();
              } catch {
                return route.fulfill({ response: res });
              }
              const next = a.transform ? a.transform(body, this.state.current) : { ...body, ...this.state.current };
              await route.fulfill({ response: res, json: next });
            });
          }
          break;
        case 'query':
          break; // applied per-navigation in transformUrl
        case 'custom':
          await a.apply({ context, baseURL, flags });
          break;
      }
    }
    this.routesInstalled = true;
  }

  transformUrl(url: string): string {
    let out = url;
    const flags = this.state.current;
    if (!Object.keys(flags).length) return out;
    for (const a of this.adapters) {
      if (a.type === 'query') {
        const u = new URL(out);
        u.searchParams.set(a.param, encodeFlags(flags, a.encode));
        out = u.toString();
      } else if (a.type === 'custom' && a.transformUrl) out = a.transformUrl(out, flags);
    }
    return out;
  }
}
