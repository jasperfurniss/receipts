import type { BrowserContext, Locator, Page } from 'playwright';

export const OVERLAY_ID = '__receipts_overlay';

/**
 * Init script: renders the persistent chapter badge after every navigation and exposes
 * `window.__receiptsRender(state, card)` for explicit chapter cards. The overlay never takes
 * pointer events and is hidden for step screenshots.
 */
export function overlayInitScript() {
  const fn = (id: string) => {
    const w = window as any;
    const render = (state: { title: string; index: number; total: number; key: string } | null, card: boolean) => {
      if (!state || !document.documentElement) return;
      let root = document.getElementById(id);
      if (!root) {
        root = document.createElement('div');
        root.id = id;
        root.setAttribute('aria-hidden', 'true');
        root.style.cssText =
          'position:fixed;inset:0;pointer-events:none;z-index:2147483647;font:600 15px/1.35 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;';
        (document.body || document.documentElement).appendChild(root);
      }
      const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
      const badge = `<div style="position:absolute;left:12px;bottom:12px;background:rgba(17,24,39,.88);color:#fff;padding:6px 10px;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.25);max-width:60%">🧾 <span style="opacity:.7">${state.index}/${state.total}</span> ${esc(state.title)}</div>`;
      const big = card
        ? `<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(17,24,39,.55)"><div style="background:#111827;color:#fff;padding:22px 30px;border-radius:14px;max-width:70%;text-align:center;box-shadow:0 10px 30px rgba(0,0,0,.4)"><div style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;opacity:.65">Receipts · ${esc(state.key)} · step ${state.index} of ${state.total}</div><div style="font-size:24px;margin-top:6px">${esc(state.title)}</div></div></div>`
        : '';
      root.innerHTML = big + badge;
    };
    w.__receiptsRender = render;
    const restore = async () => {
      try {
        const s = await w.__receiptsGetChapter?.();
        render(s, false);
      } catch {
        /* binding not ready */
      }
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', restore);
    else restore();
  };
  return `(${fn.toString()})(${JSON.stringify(OVERLAY_ID)});`;
}

export interface ChapterState {
  title: string;
  index: number;
  total: number;
  key: string;
}

export async function installOverlay(context: BrowserContext, get: () => ChapterState | null) {
  await context.exposeBinding('__receiptsGetChapter', () => get());
  await context.addInitScript({ content: overlayInitScript() });
}

export async function showChapterCard(page: Page, state: ChapterState, holdMs: number) {
  if (page.url() === 'about:blank') return false;
  try {
    await page.evaluate(([s]) => (window as any).__receiptsRender?.(s, true), [state] as const);
    await page.waitForTimeout(holdMs);
    await page.evaluate(([s]) => (window as any).__receiptsRender?.(s, false), [state] as const);
    return true;
  } catch {
    return false;
  }
}

/** Brief highlight ring around the element about to be acted on ("action callout"). */
export async function callout(locator: Locator, ms = 350) {
  try {
    await locator.evaluate((el, id) => {
      const r = el.getBoundingClientRect();
      const root = document.getElementById(id as string);
      if (!root) return;
      const ring = document.createElement('div');
      ring.style.cssText = `position:absolute;left:${r.left - 4}px;top:${r.top - 4}px;width:${r.width + 8}px;height:${r.height + 8}px;border:3px solid #f59e0b;border-radius:8px;box-shadow:0 0 0 4px rgba(245,158,11,.3);transition:opacity .2s`;
      root.appendChild(ring);
      setTimeout(() => ring.remove(), 900);
    }, OVERLAY_ID, { timeout: 1500 });
    await locator.page().waitForTimeout(ms);
  } catch {
    /* element may not be ready yet; the action itself will report */
  }
}
