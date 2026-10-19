import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { Manifest, RunSummary } from '../manifest.js';

export const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function fmtMs(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Static Playwright Trace Viewer shipped inside playwright-core (self-hostable, never trace.playwright.dev). */
export function traceViewerDir(): string | undefined {
  try {
    const req = createRequire(import.meta.url);
    const pw = dirname(req.resolve('playwright/package.json'));
    const reqPw = createRequire(join(pw, 'package.json'));
    const core = dirname(reqPw.resolve('playwright-core/package.json'));
    const d = join(core, 'lib', 'vite', 'traceViewer');
    return existsSync(join(d, 'index.html')) ? d : undefined;
  } catch {
    return undefined;
  }
}

export const STYLES = `
:root{--bg:#f8fafc;--card:#fff;--ink:#0f172a;--mute:#64748b;--line:#e2e8f0;--ok:#15803d;--bad:#b91c1c;--warn:#a16207;--ai:#6d28d9}
*{box-sizing:border-box}body{margin:0;font:14px/1.5 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--ink)}
header.top{background:#0f172a;color:#fff;padding:14px 24px;display:flex;gap:16px;align-items:center;flex-wrap:wrap}
header.top a{color:#cbd5e1}header.top .brand{font-weight:700;font-size:18px}
main{max-width:1200px;margin:0 auto;padding:20px}
.meta{color:var(--mute);font-size:13px}.meta code{background:#eef2f7;padding:1px 5px;border-radius:4px;color:var(--ink)}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px;margin:16px 0}
.pill{display:inline-block;padding:2px 9px;border-radius:999px;font-size:12px;font-weight:600}
.pill.passed{background:#dcfce7;color:var(--ok)}.pill.failed,.pill.error{background:#fee2e2;color:var(--bad)}.pill.skipped{background:#f1f5f9;color:var(--mute)}
.pill.ai{background:#ede9fe;color:var(--ai)}.pill.warn,.pill.unsure{background:#fef9c3;color:var(--warn)}
.grid{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,1fr);gap:18px}@media(max-width:900px){.grid{grid-template-columns:1fr}}
video{width:100%;border-radius:8px;background:#000}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}th{font-size:12px;color:var(--mute);font-weight:600}
.steps li{margin:6px 0;list-style:none}.steps{padding:0;margin:0}.step-h{display:flex;gap:8px;align-items:center}
.seek{border:1px solid var(--line);background:#fff;border-radius:6px;padding:1px 7px;cursor:pointer;font:12px monospace}
.asserts{margin:4px 0 0 26px;padding:0}.asserts li{font-size:13px;color:#334155}
.shots{display:flex;flex-wrap:wrap;gap:10px}.shots figure{margin:0;width:220px}.shots img{width:100%;border:1px solid var(--line);border-radius:6px}.shots figcaption{font-size:12px;color:var(--mute)}
.links a{margin-right:12px}iframe.trace{width:100%;height:720px;border:1px solid var(--line);border-radius:8px;background:#fff}
pre{background:#0f172a;color:#e2e8f0;padding:12px;border-radius:8px;overflow:auto;max-height:420px;font-size:12px}
details summary{cursor:pointer;color:#334155;font-weight:600;margin:8px 0}
.err{color:var(--bad);font-size:13px}
`;

export interface RenderOpts {
  /** URL for an artifact inside a scenario directory. */
  asset: (scenarioDir: string, rel: string) => string;
  /** URL to an embeddable trace viewer for this scenario, if served. */
  traceViewer?: (scenarioDir: string) => string | undefined;
  /** Shown instead of an embedded viewer in the static report. */
  traceCommand?: (scenarioDir: string) => string;
  nav?: string;
  extraHead?: string;
  compareLink?: string;
}

function assertionLi(a: Manifest['steps'][number]['assertions'][number]) {
  const icon = a.status === 'passed' ? '✅' : a.status === 'failed' ? '❌' : a.status === 'skipped' ? '⏭️' : '⚠️';
  const ai = a.aiJudged ? ` <span class="pill ai">🤖 AI-judged</span>` : '';
  const actual = a.actual !== undefined ? ` → <code>${esc(a.actual)}</code>` : '';
  const extra = a.rationale ? `<div class="meta">${esc(a.rationale)}</div>` : '';
  const err = a.error ? `<div class="err">${esc(a.error)}</div>` : '';
  return `<li>${icon}${ai} ${esc(a.description)}${actual}${extra}${err}</li>`;
}

export function renderScenario(m: Manifest, dir: string, o: RenderOpts): string {
  const vid = m.artifacts.find((a) => a.kind === 'video');
  const vidId = `v-${dir.replace(/[^a-z0-9]/gi, '_')}`;
  const steps = m.steps
    .map(
      (s) => `<li id="${esc(dir)}-step-${s.index}"><div class="step-h"><span class="pill ${s.status}">${s.status}</span>
      ${vid && s.startedAt ? `<button class="seek" data-v="${vidId}" data-t="${s.videoOffsetMs / 1000}">▶ ${fmtMs(s.videoOffsetMs)}</button>` : ''}
      <strong>${s.index}. ${esc(s.chapter)}</strong> <span class="meta">${esc(s.action)} · ${(s.durationMs / 1000).toFixed(1)}s</span></div>
      ${s.assertions.length ? `<ul class="asserts">${s.assertions.map(assertionLi).join('')}</ul>` : ''}
      ${s.error ? `<div class="err" style="margin-left:26px">${esc(s.error)}</div>` : ''}</li>`,
    )
    .join('');
  const shots = m.steps
    .filter((s) => s.screenshot)
    .map((s) => `<figure><a href="${esc(o.asset(dir, s.screenshot!.path))}" target="_blank"><img loading="lazy" src="${esc(o.asset(dir, s.screenshot!.path))}" alt="${esc(s.screenshot!.name)}"></a><figcaption>${s.index}. ${esc(s.screenshot!.name)} · ${s.screenshot!.maskedElements} masked</figcaption></figure>`)
    .join('');
  const tv = o.traceViewer?.(dir);
  const flags = Object.entries(m.flags.requested).map(([k, v]) => `<code>${esc(k)}=${esc(v === true ? 'on' : v === false ? 'off' : v)}</code>`).join(' ') || '<code>none</code>';
  const v = m.verdicts;
  return `<section class="card" id="${esc(dir)}">
  <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap"><h2 style="margin:0;font-size:18px"><span class="pill ${m.status}">${m.status}</span> <code>${esc(m.key)}</code> ${esc(m.title)}</h2>
  <div class="meta">${(m.timing.durationMs / 1000).toFixed(1)}s</div></div>
  <p class="meta">persona <code>${esc(m.persona.name)}</code> · flags ${flags} · <code>${esc(m.git.shortSha)}</code>${m.git.dirty ? ' (dirty)' : ''} · ${esc(m.environment.browser)} ${esc(m.environment.browserVersion)} · scenario <code>${esc(m.scenario.hash.slice(0, 10))}</code>
  · ${v.deterministic.passed}/${v.deterministic.passed + v.deterministic.failed} deterministic checks${v.aiJudged.passed + v.aiJudged.failed + v.aiJudged.unsure + v.aiJudged.skipped ? ` · <span class="pill ai">🤖 ${v.aiJudged.passed} pass / ${v.aiJudged.failed} fail / ${v.aiJudged.unsure} unsure / ${v.aiJudged.skipped} skipped</span>` : ''}</p>
  ${m.covers.length ? `<p class="meta">Covers: ${m.covers.map((c) => `“${esc(c)}”`).join(', ')}</p>` : ''}
  ${m.error ? `<p class="err">${esc(m.error)}</p>` : ''}
  <div class="grid">
    <div id="${esc(dir)}-video">${vid ? `<video id="${vidId}" controls preload="metadata" src="${esc(o.asset(dir, vid.path))}"></video>` : '<p class="meta">No video recorded.</p>'}</div>
    <div><ol class="steps">${steps}</ol></div>
  </div>
  <h3 id="${esc(dir)}-shots">Screenshots</h3><div class="shots">${shots || '<span class="meta">none</span>'}</div>
  <h3 id="${esc(dir)}-trace">Trace</h3>
  <p class="links"><a href="${esc(o.asset(dir, 'trace.zip'))}">trace.zip</a> <a href="${esc(o.asset(dir, 'console.json'))}" id="${esc(dir)}-console">console.json</a> (${m.console.errors} errors, ${m.console.warnings} warnings) <a href="${esc(o.asset(dir, 'network.json'))}">network.json</a> (${m.network.requests} requests, ${m.network.failed} failed) <a href="${esc(o.asset(dir, 'manifest.json'))}">manifest.json</a> <a href="${esc(o.asset(dir, 'verdicts.json'))}">verdicts.json</a></p>
  ${tv ? `<details><summary>Open embedded Playwright Trace Viewer</summary><iframe class="trace" data-src="${esc(tv)}" title="trace viewer"></iframe></details>` : o.traceCommand ? `<p class="meta">Open locally: <code>${esc(o.traceCommand(dir))}</code></p>` : ''}
  <details><summary>Redaction &amp; provenance</summary><p class="meta">Blurred selectors: ${m.redaction.selectors.concat(`[${m.redaction.attribute}]`).map((s) => `<code>${esc(s)}</code>`).join(' ')} (${esc(m.redaction.style)}, up to ${m.redaction.maskedElementsMax} element(s) on screen).
  Scrubber: ${m.redaction.scrubber.headersStripped} header/cookie value(s) stripped, ${m.redaction.scrubber.secretsReplaced} secret/PII string(s) replaced, ${m.redaction.scrubber.bodiesDropped} bodies dropped · residual secrets: <strong>${m.redaction.residualSecrets}</strong>.</p>
  <p class="meta">Limitations:</p><ul class="meta">${m.limitations.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
  <p class="meta">manifest hash <code>${esc(m.manifestHash)}</code></p></details>
</section>`;
}

const SCRIPT = `<script>
document.addEventListener('click',e=>{const b=e.target.closest('.seek');if(!b)return;const v=document.getElementById(b.dataset.v);if(!v)return;v.currentTime=Number(b.dataset.t);v.play();v.scrollIntoView({behavior:'smooth',block:'center'});});
document.querySelectorAll('details').forEach(d=>d.addEventListener('toggle',()=>{const f=d.querySelector('iframe[data-src]');if(d.open&&f&&!f.src)f.src=f.dataset.src;}));
</script>`;

export function renderRunPage(summary: RunSummary, manifests: Manifest[], o: RenderOpts): string {
  const rows = summary.scenarios
    .map((s) => `<tr><td><span class="pill ${s.status}">${s.status}</span></td><td><a href="#${esc(s.dir)}"><code>${esc(s.key)}</code></a></td><td>${esc(s.title)}</td><td><code>${esc(s.persona)}</code></td><td>${Object.entries(s.flags).map(([k, v]) => `<code>${esc(k)}=${v === true ? 'on' : v === false ? 'off' : esc(v)}</code>`).join(' ')}</td><td>${(s.durationMs / 1000).toFixed(1)}s</td></tr>`)
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Receipts · ${esc(summary.runId)}</title><style>${STYLES}</style>${o.extraHead ?? ''}</head><body>
<header class="top"><span class="brand">🧾 Receipts</span>${o.nav ?? ''}<span class="meta" style="color:#94a3b8">run <code>${esc(summary.runId)}</code></span></header>
<main>
<div class="card"><h1 style="margin:0 0 6px;font-size:20px">${summary.totals.failed ? '❌' : '✅'} ${summary.totals.passed}/${summary.scenarios.length} scenarios passed</h1>
<p class="meta"><code>${esc(summary.git.shortSha)}</code> on <code>${esc(summary.git.branch ?? '?')}</code>${summary.git.dirty ? ' (uncommitted changes)' : ''} · ${esc(summary.browser)} · ${esc(summary.baseURL)} · ${(summary.durationMs / 1000).toFixed(1)}s · ${esc(new Date(summary.createdAt).toLocaleString())}${summary.pr ? ` · PR #${summary.pr.number}` : ''}${o.compareLink ?? ''}</p>
<table><tr><th></th><th>Scenario</th><th>Title</th><th>Persona</th><th>Flags</th><th>Time</th></tr>${rows}</table></div>
${summary.scenarios.map((s) => {
    const m = manifests.find((x) => x.key === s.key);
    return m ? renderScenario(m, s.dir, o) : '';
  }).join('\n')}
<p class="meta">🔒 Evidence stays private: nothing in this report references public URLs.</p>
</main>${SCRIPT}</body></html>`;
}

export function loadRun(runDir: string): { summary: RunSummary; manifests: Manifest[] } {
  const summary = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8')) as RunSummary;
  const manifests = summary.scenarios.map((s) => JSON.parse(readFileSync(join(runDir, s.dir, 'manifest.json'), 'utf8')) as Manifest);
  return { summary, manifests };
}

/** Static, self-contained local report (relative links, opens from disk). */
export function writeLocalReport(runDir: string): string {
  const { summary, manifests } = loadRun(runDir);
  const html = renderRunPage(summary, manifests, {
    asset: (dir, rel) => `${dir}/${rel}`,
    traceCommand: (dir) => `npx playwright show-trace ${join(runDir, dir, 'trace.zip')}`,
  });
  const out = join(runDir, 'report.html');
  writeFileSync(out, html);
  return out;
}
