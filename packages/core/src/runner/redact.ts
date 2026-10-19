import type { BrowserContext, Page } from 'playwright';

export function redactionCss(selectors: string[], attribute: string, style: 'blur' | 'solid'): string {
  const all = [...selectors, `[${attribute}]`].join(',\n');
  const rule =
    style === 'solid'
      ? 'background:#111 !important;color:transparent !important;border-color:#111 !important;text-shadow:none !important;'
      : 'filter:blur(12px) !important;';
  // `img`/`video` children inherit the filter; solid mode also hides media inside.
  return `${all} { ${rule} }\n${style === 'solid' ? `:is(${all}) img, :is(${all}) video { visibility:hidden !important; }` : ''}`;
}

/** Inject the redaction stylesheet at document start so it applies to the very first video frame. */
export async function installRedaction(context: BrowserContext, css: string) {
  const fn = (cssText: string) => {
    const add = () => {
      if (document.getElementById('__receipts_redact')) return;
      const s = document.createElement('style');
      s.id = '__receipts_redact';
      s.textContent = cssText;
      (document.head || document.documentElement).appendChild(s);
    };
    if (document.documentElement) add();
    else new MutationObserver((_, o) => { if (document.documentElement) { add(); o.disconnect(); } }).observe(document, { childList: true });
    document.addEventListener('DOMContentLoaded', add);
  };
  await context.addInitScript({ content: `(${fn.toString()})(${JSON.stringify(css)});` });
}

/** Text currently inside redacted elements, so it can also be scrubbed out of trace DOM snapshots. */
export async function collectRedactedText(page: Page, selectors: string[], attribute: string): Promise<{ count: number; texts: string[] }> {
  if (page.url() === 'about:blank') return { count: 0, texts: [] };
  try {
    return await page.evaluate(
      ([sel]) => {
        const els = Array.from(document.querySelectorAll(sel as string));
        const texts = new Set<string>();
        for (const el of els) {
          const t = (el as HTMLElement).innerText ?? el.textContent ?? '';
          for (const part of t.split(/\n+/)) if (part.trim()) texts.add(part.trim());
          if ((el as HTMLInputElement).value) texts.add((el as HTMLInputElement).value);
          el.querySelectorAll('input,textarea').forEach((i) => (i as HTMLInputElement).value && texts.add((i as HTMLInputElement).value));
        }
        return { count: els.length, texts: [...texts] };
      },
      [[...selectors, `[${attribute}]`].join(',')] as const,
    );
  } catch {
    return { count: 0, texts: [] };
  }
}
