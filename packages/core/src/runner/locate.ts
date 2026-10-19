import type { Locator, Page } from 'playwright';
import type { Target } from '../scenario/schema.js';
import { parseRegexLiteral } from '../glob.js';

export function locate(page: Page, t: Target): Locator {
  if (typeof t === 'string') return page.locator(t);
  if ('role' in t) {
    const name = t.name !== undefined ? parseRegexLiteral(t.name) ?? t.name : undefined;
    return page.getByRole(t.role as Parameters<Page['getByRole']>[0], { name, exact: t.exact });
  }
  if ('text' in t) return page.getByText(parseRegexLiteral(t.text) ?? t.text, { exact: t.exact });
  if ('label' in t) return page.getByLabel(parseRegexLiteral(t.label) ?? t.label);
  if ('testId' in t) return page.getByTestId(t.testId);
  if ('placeholder' in t) return page.getByPlaceholder(t.placeholder);
  return page.locator(t.selector);
}

export function describeTarget(t: Target): string {
  if (typeof t === 'string') return t;
  if ('role' in t) return `role=${t.role}${t.name ? `[name="${t.name}"]` : ''}`;
  if ('text' in t) return `text ${t.text}`;
  if ('label' in t) return `label "${t.label}"`;
  if ('testId' in t) return `testId ${t.testId}`;
  if ('placeholder' in t) return `placeholder "${t.placeholder}"`;
  return t.selector;
}

/** Same target as a Playwright code expression (used by the compiler). */
export function targetToCode(t: Target, page = 'page'): string {
  const lit = (s: string) => {
    const re = parseRegexLiteral(s);
    return re ? re.toString() : JSON.stringify(s);
  };
  if (typeof t === 'string') return `${page}.locator(${JSON.stringify(t)})`;
  if ('role' in t) {
    const opts: string[] = [];
    if (t.name !== undefined) opts.push(`name: ${lit(t.name)}`);
    if (t.exact !== undefined) opts.push(`exact: ${t.exact}`);
    return `${page}.getByRole(${JSON.stringify(t.role)}${opts.length ? `, { ${opts.join(', ')} }` : ''})`;
  }
  if ('text' in t) return `${page}.getByText(${lit(t.text)}${t.exact !== undefined ? `, { exact: ${t.exact} }` : ''})`;
  if ('label' in t) return `${page}.getByLabel(${lit(t.label)})`;
  if ('testId' in t) return `${page}.getByTestId(${JSON.stringify(t.testId)})`;
  if ('placeholder' in t) return `${page}.getByPlaceholder(${JSON.stringify(t.placeholder)})`;
  return `${page}.locator(${JSON.stringify(t.selector)})`;
}
