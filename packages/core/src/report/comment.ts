import type { Manifest, RunSummary } from '../manifest.js';
import { itemStatus, type PlanMapping } from '../testplan.js';

export const STICKY_MARKER = '<!-- receipts:sticky -->';

export interface CommentInput {
  summary: RunSummary;
  manifests: Manifest[];
  mappings: PlanMapping[];
  /** Current PR head; if it differs from the evidence SHA the comment says so. */
  headSha?: string;
  /** Link to a scenario's evidence (viewer URL, or an Actions artifact URL fallback). */
  link?: (m: Manifest, anchor?: 'video' | 'shots' | 'trace' | 'console') => string | undefined;
  expiresDays?: number;
  /** Shown when evidence is only available as a GitHub Actions artifact. */
  artifactUrl?: string;
  /** Set while a re-run is in progress. */
  rerunning?: boolean;
  /** Override the footer privacy line (e.g. for local dry runs). */
  privacyNote?: string;
}

const icon = (s: string) => (s === 'passed' || s === 'verified' ? '✅' : s === 'manual' ? '⚪' : s === 'not-run' ? '⏭️' : '❌');
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

function keyResult(m: Manifest, cover?: string): string {
  if (m.status === 'error') return m.error ?? 'error';
  const failed = m.steps.flatMap((s) => s.assertions.filter((a) => a.status === 'failed').map((a) => ({ s, a })));
  if (failed.length) {
    const { s, a } = failed[0]!;
    return `${s.chapter} › ${a.description} → ${a.actual ?? a.error ?? 'failed'}`;
  }
  const stepErr = m.steps.find((s) => s.error);
  if (stepErr) return `${stepErr.chapter}: ${stepErr.error}`;
  // Prefer the check that matches what this Test Plan item talks about.
  const all = m.steps.flatMap((st) => st.assertions.filter((x) => !x.aiJudged));
  const want = cover ? (/console|error/i.test(cover) ? 'console' : /request|api|call|network/i.test(cover) ? 'request' : /url|redirect|lands on/i.test(cover) ? 'url' : undefined) : undefined;
  const pick = want ? [...all].reverse().find((x) => x.kind === want) : undefined;
  if (pick) return `${pick.description} → **${pick.actual ?? pick.status}**`;
  // Otherwise the most "telling" deterministic check: media/request in the last asserting step.
  const lastAsserting = [...m.steps].reverse().find((s) => s.assertions.some((a) => !a.aiJudged && a.kind !== 'console'));
  const a = lastAsserting?.assertions.find((x) => !x.aiJudged && (x.kind === 'media' || x.kind === 'request')) ?? lastAsserting?.assertions.find((x) => !x.aiJudged);
  return a ? `${a.description} → **${a.actual ?? a.status}**` : `${m.verdicts.deterministic.passed} checks passed`;
}

function evidenceLinks(m: Manifest, link: CommentInput['link']): string {
  if (!link) return 'local only';
  const shots = m.artifacts.filter((a) => a.kind === 'screenshot').length;
  const videoStep = m.steps.find((s) => s.startedAt);
  const parts = [
    link(m, 'video') && `[▶ video](${link(m, 'video')})`,
    shots && link(m, 'shots') && `[${shots} shot${shots === 1 ? '' : 's'}](${link(m, 'shots')})`,
    link(m, 'trace') && `[trace](${link(m, 'trace')})`,
  ].filter(Boolean);
  void videoStep;
  return parts.join(' · ');
}

export function renderComment(i: CommentInput): string {
  const { summary, manifests, mappings } = i;
  const byKey = new Map(manifests.map((m) => [m.key, m]));
  const results: Record<string, 'passed' | 'failed' | undefined> = {};
  for (const m of manifests) results[m.key] = m.status === 'passed' ? 'passed' : 'failed';
  const statuses = mappings.map((mp) => itemStatus(mp, results));
  const verified = statuses.filter((s) => s === 'verified').length;
  const passed = manifests.filter((m) => m.status === 'passed').length;
  const sha = summary.git.shortSha;
  const stale = i.headSha && !i.headSha.startsWith(summary.git.sha) && !summary.git.sha.startsWith(i.headSha);
  const lines: string[] = [STICKY_MARKER];
  if (stale) lines.push(`### ⏳ Receipts: stale (evidence is for \`${sha}\`, head is \`${i.headSha!.slice(0, 7)}\`)${i.rerunning ? ', re-running…' : ''}`);
  lines.push(
    `### 🧾 Receipts: ${passed}/${manifests.length} scenarios passed${mappings.length ? ` · ${verified}/${mappings.length} Test Plan items verified` : ''}`,
  );
  const personas = [...new Set(manifests.map((m) => m.persona.name))];
  const flagStr = [...new Set(manifests.flatMap((m) => Object.entries(m.flags.requested).map(([k, v]) => `${k}=${v === true ? 'on' : v === false ? 'off' : v}`)))];
  lines.push(
    `\`${sha}\`${summary.git.dirty ? ' (dirty)' : ''} · ${summary.browser} · persona${personas.length > 1 ? 's' : ''} ${personas.map((p) => `\`${p}\``).join(', ')}${flagStr.length ? ` · flags ${flagStr.map((f) => `\`${f}\``).join(', ')}` : ''} · ${fmtDur(summary.durationMs)}`,
  );
  lines.push('');
  const covered = new Set<string>();
  if (mappings.length) {
    lines.push('| Test Plan item | Scenario | Result | Evidence |', '|---|---|---|---|');
    mappings.forEach((mp, idx) => {
      const st = statuses[idx]!;
      if (!mp.scenarios.length) {
        lines.push(`| ${cell(mp.item.text)} | — | ⚪ manual (not verified by Receipts) | — |`);
        return;
      }
      const keys = mp.scenarios.map((s) => s.key).filter((k) => byKey.has(k));
      keys.forEach((k) => covered.add(k));
      if (!keys.length) {
        lines.push(`| ${cell(mp.item.text)} | ${mp.scenarios.map((s) => `\`${s.key}\``).join(', ')} | ⏭️ not run | — |`);
        return;
      }
      const ms = keys.map((k) => byKey.get(k)!);
      const result = ms.map((m) => `${icon(m.status)} ${keyResult(m, mp.scenarios.find((x) => x.key === m.key)?.cover ?? mp.item.text)}`).join('<br>');
      const ev = ms.map((m) => evidenceLinks(m, i.link)).join('<br>');
      lines.push(`| ${cell(mp.item.text)} | ${keys.map((k) => `\`${k}\``).join(', ')} | ${cell(st === 'verified' ? result : result)} | ${ev} |`);
    });
  }
  const others = manifests.filter((m) => !covered.has(m.key));
  if (others.length) {
    if (mappings.length) lines.push('', `**Other scenarios** (not mapped to a Test Plan item)`);
    lines.push('', '| Scenario | Result | Evidence |', '|---|---|---|');
    for (const m of others) lines.push(`| \`${m.key}\` | ${icon(m.status)} ${cell(keyResult(m))} | ${evidenceLinks(m, i.link)} |`);
  }
  lines.push('', '<details><summary>Assertion details</summary>', '');
  for (const m of manifests) {
    for (const s of m.steps)
      for (const a of s.assertions) {
        const ai = a.aiJudged ? '🤖 *AI-judged*: ' : '';
        lines.push(`- \`${m.key}\` › ${s.chapter} › ${ai}${a.description} → ${a.actual ?? a.status} ${icon(a.status === 'skipped' ? 'not-run' : a.status === 'warn' || a.status === 'unsure' ? 'manual' : a.status)}${a.rationale ? ` _(${a.rationale})_` : ''}`);
      }
    if (m.steps.some((s) => s.error)) for (const s of m.steps.filter((x) => x.error)) lines.push(`- \`${m.key}\` › ${s.chapter} › error: ${s.error}`);
  }
  const masked = manifests.reduce((n, m) => n + m.steps.filter((s) => s.screenshot).length, 0);
  const residual = manifests.reduce((n, m) => n + m.redaction.residualSecrets, 0);
  const stripped = manifests.reduce((n, m) => n + m.redaction.scrubber.headersStripped + m.redaction.scrubber.secretsReplaced, 0);
  const sel = new Set(manifests.flatMap((m) => m.redaction.selectors));
  lines.push(`- Redaction: ${sel.size + 1} selector(s) masked in ${masked} screenshot(s) and video · scrubber: ${stripped} value(s) stripped, ${residual} residual secrets`);
  const unmapped = mappings.filter((m) => !m.scenarios.length).length;
  if (unmapped) lines.push(`- ${unmapped} Test Plan item(s) have no scenario; they stay \`manual\`. Add a \`covers:\` line to map them.`);
  lines.push('</details>', '');
  const where = i.link ? 'Evidence is private to org members (SSO).' : i.artifactUrl ? `Evidence bundle: [Actions artifact](${i.artifactUrl}) (repo members only).` : 'Evidence is in the workflow run artifacts.';
  lines.push(`🔒 ${i.privacyNote ?? where}${i.expiresDays ? ` Expires in ${i.expiresDays} days.` : ''} Re-runs automatically on push.`);
  return lines.join('\n') + '\n';
}

function fmtDur(ms: number) {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

export interface CheckSummary {
  name: 'receipts/evidence';
  conclusion: 'success' | 'failure' | 'neutral';
  title: string;
  summary: string;
}

export function renderCheck(i: CommentInput): CheckSummary {
  const { manifests, mappings } = i;
  if (!manifests.length)
    return { name: 'receipts/evidence', conclusion: 'neutral', title: 'No scenarios matched this PR', summary: 'No Receipts scenarios were selected for this change.' };
  const failed = manifests.filter((m) => m.status !== 'passed');
  const results: Record<string, 'passed' | 'failed' | undefined> = {};
  for (const m of manifests) results[m.key] = m.status === 'passed' ? 'passed' : 'failed';
  const verified = mappings.filter((mp) => itemStatus(mp, results) === 'verified').length;
  const title = failed.length
    ? `${failed.length} of ${manifests.length} scenario(s) failed`
    : `${manifests.length} scenario(s) passed${mappings.length ? `, ${verified}/${mappings.length} Test Plan items verified` : ''}`;
  return { name: 'receipts/evidence', conclusion: failed.length ? 'failure' : 'success', title, summary: renderComment(i).replace(STICKY_MARKER + '\n', '') };
}
