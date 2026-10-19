/** Parse a PR body's Test Plan checklist and map items to scenarios via their `covers:` text. */

export interface TestPlanItem {
  text: string;
  checked: boolean;
  /** 0-based line index in the original body */
  line: number;
  indent: number;
}

const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const CHECKBOX = /^(\s*)[-*+]\s+\[( |x|X)\]\s+(.*?)\s*$/;

export function isTestPlanHeading(text: string): boolean {
  return /^(test(ing)?\s*plan|how\s+to\s+test|testing|qa(\s+plan)?|verification)\b/i.test(text.trim());
}

export function parseTestPlan(body: string): TestPlanItem[] {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const items: TestPlanItem[] = [];
  let inPlan = false;
  let level = 0;
  let inFence = false;
  lines.forEach((raw, i) => {
    if (/^\s*(```|~~~)/.test(raw)) inFence = !inFence;
    if (inFence) return;
    const h = HEADING.exec(raw);
    if (h) {
      const lvl = h[1]!.length;
      if (isTestPlanHeading(stripAnnotation(h[2]!))) {
        inPlan = true;
        level = lvl;
      } else if (inPlan && lvl <= level) inPlan = false;
      return;
    }
    if (!inPlan) return;
    const m = CHECKBOX.exec(raw);
    if (m) items.push({ text: stripAnnotation(m[3]!), checked: m[2] !== ' ', line: i, indent: m[1]!.length });
  });
  return items;
}

const ANNOTATION = /\s*<!--\s*receipts\s*-->.*$/;
export function stripAnnotation(s: string) {
  return s.replace(ANNOTATION, '').trim();
}

export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/`([^`]*)`/g, '$1')
    .replace(/[→⇒>]+|->|=>/g, ' ')
    .replace(/[^a-z0-9~:./ -]+/g, ' ')
    .replace(/[:,.;]+(\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'to', 'of', 'on', 'in', 'is', 'it', 'at', 'as', 'be', 'with', 'for']);
function tokens(s: string): string[] {
  return normalizeText(s).split(' ').filter((t) => t && !STOP.has(t));
}
function bigrams(s: string): Map<string, number> {
  const n = normalizeText(s).replace(/ /g, '');
  const m = new Map<string, number>();
  for (let i = 0; i < n.length - 1; i++) {
    const b = n.slice(i, i + 2);
    m.set(b, (m.get(b) ?? 0) + 1);
  }
  return m;
}
function dice(a: string, b: string): number {
  const A = bigrams(a);
  const B = bigrams(b);
  let inter = 0;
  let total = 0;
  for (const [k, v] of A) {
    inter += Math.min(v, B.get(k) ?? 0);
    total += v;
  }
  for (const v of B.values()) total += v;
  return total === 0 ? 0 : (2 * inter) / total;
}

/**
 * Similarity in [0, 1] between a Test Plan item and a `covers:` phrase. Rewards the cover being
 * contained in the item (authors usually paste a prefix), blended with character-bigram overlap.
 */
export function coverScore(item: string, cover: string): number {
  const it = tokens(item);
  const cv = tokens(cover);
  if (!it.length || !cv.length) return 0;
  if (normalizeText(item) === normalizeText(cover)) return 1;
  const itSet = new Set(it);
  const contained = cv.filter((t) => itSet.has(t)).length / cv.length;
  const reverse = it.filter((t) => new Set(cv).has(t)).length / it.length;
  // Short covers ("video") shouldn't swallow everything.
  const lenPenalty = cv.length < 3 ? 0.75 : 1;
  return Math.min(1, (0.55 * contained + 0.15 * reverse + 0.3 * dice(item, cover)) * lenPenalty);
}

export interface CoverSource {
  key: string;
  covers: string[];
}
export interface PlanMapping {
  item: TestPlanItem;
  /** Scenario keys that cover this item (best score first). Empty = manual. */
  scenarios: { key: string; cover: string; score: number }[];
}

export function mapTestPlan(items: TestPlanItem[], sources: CoverSource[], threshold = 0.6): PlanMapping[] {
  return items.map((item) => {
    const hits: { key: string; cover: string; score: number }[] = [];
    for (const s of sources) {
      let best = { cover: '', score: 0 };
      for (const c of s.covers) {
        const sc = coverScore(item.text, c);
        if (sc > best.score) best = { cover: c, score: sc };
      }
      if (best.score >= threshold) hits.push({ key: s.key, ...best });
    }
    hits.sort((a, b) => b.score - a.score);
    // Keep only near-best matches so one fuzzy collision doesn't pull in an unrelated scenario.
    const top = hits[0]?.score ?? 0;
    return { item, scenarios: hits.filter((h) => h.score >= top - 0.15) };
  });
}

export type ItemStatus = 'verified' | 'failed' | 'manual' | 'not-run';

export function itemStatus(m: PlanMapping, results: Record<string, 'passed' | 'failed' | undefined>): ItemStatus {
  if (!m.scenarios.length) return 'manual';
  const rs = m.scenarios.map((s) => results[s.key]);
  if (rs.some((r) => r === 'failed')) return 'failed';
  if (rs.every((r) => r === 'passed')) return 'verified';
  return 'not-run';
}

/**
 * Optionally rewrite Test Plan checkbox lines with evidence links. Idempotent (previous annotations
 * are replaced). Only ticks boxes that a passing scenario verified; never unticks a manual tick.
 */
export function annotateTestPlan(
  body: string,
  mappings: PlanMapping[],
  results: Record<string, 'passed' | 'failed' | undefined>,
  link: (key: string) => string,
  opts: { tick?: boolean } = {},
): string {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  for (const m of mappings) {
    const st = itemStatus(m, results);
    if (st === 'manual' || st === 'not-run') continue;
    const raw = lines[m.item.line]!;
    const cb = CHECKBOX.exec(raw);
    if (!cb) continue;
    const box = st === 'verified' && opts.tick !== false ? 'x' : cb[2];
    const k = m.scenarios[0]!.key;
    const note = st === 'verified' ? `✅ [evidence](${link(k)})` : `❌ [failed](${link(k)})`;
    lines[m.item.line] = `${cb[1]}- [${box}] ${stripAnnotation(cb[3]!)} <!-- receipts --> ${note}`;
  }
  return lines.join('\n');
}
