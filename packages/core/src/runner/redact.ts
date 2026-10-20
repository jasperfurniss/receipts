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

/**
 * Inject the redaction stylesheet at document start so it applies to the very first video frame.
 * The same stylesheet is also added to every shadow root (open or closed) as it's attached, so
 * account menus inside web components (e.g. a design-system header) get blurred too.
 */
export async function installRedaction(context: BrowserContext, css: string) {
  const fn = (cssText: string) => {
    const ID = '__receipts_redact';
    const addTo = (root: Document | ShadowRoot) => {
      const host = root instanceof Document ? root.head || root.documentElement : root;
      if (!host || root.querySelector?.(`style#${ID}`)) return;
      const s = document.createElement('style');
      s.id = ID;
      s.textContent = cssText;
      host.appendChild(s);
    };
    const add = () => addTo(document);
    const orig = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (this: Element, init: ShadowRootInit) {
      const root = orig.call(this, init);
      const ensure = () => addTo(root);
      ensure();
      // Components may replace their children on first render; re-add after it.
      queueMicrotask(ensure);
      setTimeout(ensure, 0);
      new MutationObserver(ensure).observe(root, { childList: true });
      return root;
    };
    // Declarative shadow DOM (SSR'd web components) never calls attachShadow, so also sweep open
    // shadow roots already in the page: on every frame while loading, then a few times a second.
    const sweep = (root: Document | ShadowRoot) => {
      root.querySelectorAll('*').forEach((e) => {
        if (e.shadowRoot) {
          addTo(e.shadowRoot);
          sweep(e.shadowRoot);
        }
      });
    };
    const sweepAll = () => { try { sweep(document); } catch { /* page tearing down */ } };
    const frame = () => { sweepAll(); if (document.readyState !== 'complete') requestAnimationFrame(frame); };
    requestAnimationFrame(frame);
    setInterval(sweepAll, 250);
    if (document.documentElement) add();
    else new MutationObserver((_, o) => { if (document.documentElement) { add(); o.disconnect(); } }).observe(document, { childList: true });
    document.addEventListener('DOMContentLoaded', () => { add(); sweepAll(); });
  };
  await context.addInitScript({ content: `(${fn.toString()})(${JSON.stringify(css)});` });
}

/** Text currently inside redacted elements, so it can also be scrubbed out of trace DOM snapshots. */
export async function collectRedactedText(page: Page, selectors: string[], attribute: string): Promise<{ count: number; texts: string[] }> {
  if (page.url() === 'about:blank') return { count: 0, texts: [] };
  try {
    return await page.evaluate(
      ([sel]) => {
        const els: Element[] = [];
        const walk = (root: Document | ShadowRoot) => {
          els.push(...Array.from(root.querySelectorAll(sel as string)));
          root.querySelectorAll('*').forEach((e) => e.shadowRoot && walk(e.shadowRoot));
        };
        walk(document);
        const texts = new Set<string>();
        for (const el of els) {
          const shadowText = (e: Element): string => (e.shadowRoot ? Array.from(e.shadowRoot.querySelectorAll('*')).map((c) => (c.children.length ? '' : c.textContent ?? '') + '\n' + shadowText(c)).join('\n') : '');
          const t = ((el as HTMLElement).innerText ?? el.textContent ?? '') + '\n' + shadowText(el);
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
