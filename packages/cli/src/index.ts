#!/usr/bin/env node
import { Command } from 'commander';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, rmSync, readdirSync, statSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { join, relative, resolve } from 'node:path';
import {
  compileScenarioFile,
  createStore,
  findScenarioFiles,
  hasFfmpeg,
  isUp,
  loadConfig,
  loadScenarioFile,
  mapTestPlan,
  parseTestPlan,
  publishRun,
  readStepCache,
  resolveProvider,
  runScenarios,
  selectScenarios,
  stepHash,
  verifyBundle,
  writeLocalReport,
  writeStepCache,
  renderComment,
  loadRun,
  gitInfo,
  repoSlug,
  traceViewerDir,
  ensurePersonaState,
  type LoadedConfig,
  type ResolvedScenario,
} from '@receipts/core';
import { createViewer, type AuthConfig } from '@receipts/viewer';
import { runCi } from '@receipts/action';
import { CONFIG_TEMPLATE, SCENARIO_TEMPLATE, WORKFLOW_TEMPLATE } from './templates.js';

const program = new Command();
program.name('receipts').description('Show your receipts: video, screenshots, traces and verdicts for every PR claim.').version('0.1.0');
program.option('-c, --config <file>', 'path to receipts.config.ts');

const cfg = () => loadConfig(process.cwd(), program.opts().config);
const rel = (l: LoadedConfig, p: string) => relative(process.cwd(), p) || '.';

function allScenarios(l: LoadedConfig): { resolved: ResolvedScenario[]; byFile: Map<string, { resolved: ResolvedScenario[]; source: string }> } {
  const byFile = new Map<string, { resolved: ResolvedScenario[]; source: string }>();
  for (const f of findScenarioFiles(l.scenariosDir)) {
    if (f.includes(`${'/'}drafts${'/'}`)) continue;
    const { resolved, source } = loadScenarioFile(f);
    byFile.set(f, { resolved, source });
  }
  return { resolved: [...byFile.values()].flatMap((v) => v.resolved), byFile };
}

function latestRun(l: LoadedConfig, run?: string): string {
  if (run) return existsSync(run) ? resolve(run) : join(l.runsDir, run);
  const p = join(l.runsDir, 'latest');
  if (!existsSync(p)) throw new Error('no runs yet: try `receipts run --all`');
  return join(l.runsDir, readFileSync(p, 'utf8').trim());
}

function openInBrowser(target: string) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    spawn(cmd, [target], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    /* headless box */
  }
}

program
  .command('init')
  .description('add receipts.config.ts, .receipts/, a sample scenario and the GitHub workflow')
  .option('--force', 'overwrite existing files')
  .action((o) => {
    const root = process.cwd();
    const files: [string, string][] = [
      ['receipts.config.ts', CONFIG_TEMPLATE],
      ['.receipts/scenarios/example.yml', SCENARIO_TEMPLATE('example', 'Home page loads without console errors')],
      ['.github/workflows/receipts.yml', WORKFLOW_TEMPLATE],
    ];
    for (const [p, c] of files) {
      const full = join(root, p);
      if (existsSync(full) && !o.force) {
        console.log(`skip   ${p} (exists)`);
        continue;
      }
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, c);
      console.log(`create ${p}`);
    }
    mkdirSync(join(root, '.receipts/compiled'), { recursive: true });
    const gi = join(root, '.gitignore');
    const lines = ['.receipts/runs/', '.receipts/personas/', '.receipts/store/'];
    const cur = existsSync(gi) ? readFileSync(gi, 'utf8') : '';
    const add = lines.filter((x) => !cur.includes(x));
    if (add.length) appendFileSync(gi, `${cur.endsWith('\n') || !cur ? '' : '\n'}# receipts\n${add.join('\n')}\n`);
    console.log('\nNext: edit receipts.config.ts, then `npx receipts run --all` and `npx receipts open`.');
  });

program
  .command('new <title...>')
  .description('scaffold a scenario YAML')
  .option('--id <id>')
  .action(async (titleParts: string[], o) => {
    const l = await cfg();
    const title = titleParts.join(' ');
    const id = o.id ?? title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
    const file = join(l.scenariosDir, `${id}.yml`);
    if (existsSync(file)) throw new Error(`${rel(l, file)} exists`);
    mkdirSync(l.scenariosDir, { recursive: true });
    writeFileSync(file, SCENARIO_TEMPLATE(id, title));
    console.log(`created ${rel(l, file)}`);
  });

program
  .command('run [scenarios...]')
  .description('run scenarios (keys, globs, @tags or files) and write an evidence bundle to .receipts/runs/<id>/')
  .option('--all', 'run every scenario')
  .option('--headed', 'show the browser')
  .option('--base-url <url>', 'target an already-running app or preview env (skips webServer)')
  .option('--run-id <id>')
  .option('--fresh-personas', 'ignore cached persona sign-ins')
  .option('--json', 'print the run summary as JSON')
  .action(async (patterns: string[], o) => {
    const l = await cfg();
    const { resolved } = allScenarios(l);
    if (!o.all && !patterns.length) throw new Error('pass scenario keys/globs/@tags, or --all');
    const sel = o.all ? resolved : selectScenarios(resolved, patterns);
    if (!sel.length) throw new Error(`no scenarios matched ${patterns.join(' ')} (have: ${resolved.map((r) => r.key).join(', ')})`);
    const { summary, runDir } = await runScenarios(l, sel, { headed: o.headed, baseURL: o.baseUrl, runId: o.runId, freshPersonas: o.freshPersonas });
    const report = writeLocalReport(runDir);
    if (o.json) console.log(JSON.stringify(summary, null, 2));
    console.error(`\n${summary.totals.failed ? '❌' : '✅'} ${summary.totals.passed}/${summary.scenarios.length} passed${summary.totals.skipped ? ` · ${summary.totals.skipped} skipped` : ''} · report: ${rel(l, report)}`);
    process.exitCode = summary.totals.failed ? 1 : 0;
  });

program
  .command('open [run]')
  .description('open the local HTML report (or serve it with the embedded trace viewer)')
  .option('--serve', 'serve runs locally (127.0.0.1) with the embedded Playwright trace viewer')
  .option('--port <n>', 'port for --serve', '4400')
  .option('--no-browser', "don't launch a browser")
  .action(async (run: string | undefined, o) => {
    const l = await cfg();
    if (o.serve) {
      const store = createStore({ type: 'fs', dir: l.runsDir }, l.root);
      const srv = createViewer({ store, auth: { mode: 'none' } });
      srv.listen(Number(o.port), '127.0.0.1', () => {
        const id = run ?? (existsSync(join(l.runsDir, 'latest')) ? readFileSync(join(l.runsDir, 'latest'), 'utf8').trim() : '');
        const url = `http://127.0.0.1:${o.port}/${id ? `r/${id}/` : ''}`;
        console.log(`serving ${rel(l, l.runsDir)} at ${url} (Ctrl-C to stop)`);
        if (o.browser) openInBrowser(url);
      });
      return;
    }
    const dir = latestRun(l, run);
    const report = writeLocalReport(dir);
    console.log(report);
    if (o.browser) openInBrowser(report);
  });

program
  .command('compile [scenarios...]')
  .description('compile YAML scenarios to .receipts/compiled/*.spec.ts (deterministic; AI only for `do:` steps)')
  .option('--check', 'fail if compiled output is out of date (for CI)')
  .option('--no-ai', 'never call an AI provider, even if configured')
  .action(async (patterns: string[], o) => {
    const l = await cfg();
    const { byFile } = allScenarios(l);
    let stale = 0;
    let missing: string[] = [];
    // 1. Fill the step cache for natural-language steps (only with a configured provider).
    const provider = o.ai ? resolveProvider(l.config.ai) : undefined;
    const cache = readStepCache(l.compiledDir);
    const doSteps = [...byFile.values()].flatMap((v) => v.resolved.flatMap((r) => r.steps.map((s, i) => ({ r, s, i })))).filter((x) => x.s.do && !cache[stepHash(x.s.do)]);
    if (doSteps.length && provider?.compileStep && !o.check) {
      const { chromium } = await import('@receipts/core');
      const browser = await chromium.launch();
      try {
        for (const { r, s, i } of doSteps) {
          if (cache[stepHash(s.do!)]) continue;
          const lastGoto = [...r.steps.slice(0, i)].reverse().find((x) => x.goto)?.goto ?? '/';
          const state = await ensurePersonaState(browser, l, r.persona, l.config.baseURL);
          const ctx = await browser.newContext({ baseURL: l.config.baseURL, storageState: state });
          const page = await ctx.newPage();
          await page.goto(lastGoto).catch(() => {});
          const aria = await page.locator('body').ariaSnapshot().catch(() => '');
          await ctx.close();
          const code = await provider.compileStep({ instruction: s.do!, ariaSnapshot: aria, url: page.url() });
          cache[stepHash(s.do!)] = { instruction: s.do!, code, source: 'llm', provider: provider.name, createdAt: new Date().toISOString() };
          console.log(`compiled do: "${s.do}" with ${provider.name}`);
        }
      } finally {
        await browser.close();
      }
      writeStepCache(l.compiledDir, cache);
    }
    // 2. Deterministic YAML → Playwright for every scenario file.
    for (const [file, v] of byFile) {
      if (patterns.length && !selectScenarios(v.resolved, patterns).length) continue;
      const res = compileScenarioFile(l, file, v.resolved, v.source, { check: o.check });
      if (res.changed) stale++;
      missing = missing.concat(res.uncompiledSteps);
      console.log(`${o.check ? (res.changed ? 'STALE ' : 'ok    ') : res.changed ? 'wrote ' : 'same  '}${rel(l, res.file)}`);
    }
    missing = [...new Set(missing)];
    if (missing.length) {
      console.warn(`\n${missing.length} natural-language step(s) are not compiled yet:`);
      for (const m of missing) console.warn(`  - "${m}" (hash ${stepHash(m)})`);
      console.warn(provider ? '' : `Configure ai.provider (and its key) to compile them, or add code by hand to ${rel(l, join(l.compiledDir, 'steps.json'))}.`);
    }
    if (o.check && (stale || missing.length)) process.exitCode = 1;
  });

program
  .command('steps:add <instruction> <code>')
  .description('hand-write the code for a natural-language `do:` step (no AI needed)')
  .action(async (instruction: string, code: string) => {
    const l = await cfg();
    const cache = readStepCache(l.compiledDir);
    cache[stepHash(instruction)] = { instruction, code, source: 'manual', createdAt: new Date().toISOString() };
    writeStepCache(l.compiledDir, cache);
    console.log(`saved step ${stepHash(instruction)}`);
  });

program
  .command('plan')
  .description("parse a PR body's ## Test Plan checkboxes and map them to scenarios")
  .option('--body-file <file>', 'read the PR body from a file')
  .option('--pr <n>', 'read the PR body with `gh pr view` (read-only)')
  .option('--threshold <n>', 'fuzzy-match threshold 0..1', '0.6')
  .option('--draft', 'write draft scenarios for unmapped items to .receipts/scenarios/drafts/')
  .option('--json')
  .action(async (o) => {
    const l = await cfg();
    let body: string;
    if (o.bodyFile) body = readFileSync(o.bodyFile, 'utf8');
    else if (o.pr) body = JSON.parse(execFileSync('gh', ['pr', 'view', String(o.pr), '--json', 'body'], { cwd: l.root }).toString()).body;
    else body = readFileSync(0, 'utf8');
    const { resolved } = allScenarios(l);
    const items = parseTestPlan(body);
    const mappings = mapTestPlan(items, resolved.map((r) => ({ key: r.key, covers: r.covers })), Number(o.threshold));
    if (o.json) {
      console.log(JSON.stringify(mappings, null, 2));
    } else {
      if (!items.length) console.log('No "Test Plan" checkboxes found.');
      for (const m of mappings) {
        const tag = m.scenarios.length ? `→ ${m.scenarios.map((s) => `${s.key} (${s.score.toFixed(2)})`).join(', ')}` : '→ manual (no scenario covers this)';
        console.log(`${m.item.checked ? '[x]' : '[ ]'} ${m.item.text}\n      ${tag}`);
      }
      const mapped = mappings.filter((m) => m.scenarios.length).length;
      console.log(`\n${mapped}/${mappings.length} item(s) mapped to scenarios.`);
    }
    if (o.draft) {
      const provider = resolveProvider(l.config.ai);
      const dir = join(l.scenariosDir, 'drafts');
      mkdirSync(dir, { recursive: true });
      for (const m of mappings.filter((x) => !x.scenarios.length)) {
        const id = m.item.text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'draft';
        const file = join(dir, `${id}.yml`);
        if (existsSync(file)) continue;
        const yaml = provider?.draftScenario ? await provider.draftScenario({ item: m.item.text }) : SCENARIO_TEMPLATE(id, m.item.text);
        writeFileSync(file, `# DRAFT from Test Plan item: ${m.item.text}\n# Review, then move up into scenarios/ to activate.\n${yaml}`);
        console.log(`draft  ${rel(l, file)}${provider ? ` (${provider.name})` : ' (skeleton; no AI provider configured)'}`);
      }
    }
  });

program
  .command('publish [run]')
  .description('verify + upload a run bundle to the configured private store')
  .option('--pr <n>', 'PR number for the store layout')
  .action(async (run: string | undefined, o) => {
    const l = await cfg();
    if (!l.config.store) throw new Error('no store configured (receipts.config.ts → store)');
    const dir = latestRun(l, run);
    const store = createStore(l.config.store, l.root);
    const git = gitInfo(l.root);
    const repo = l.config.repo ?? repoSlug(git.remote);
    const r = await publishRun(dir, store, { repo, pr: o.pr ? Number(o.pr) : undefined, patterns: l.config.redact?.patterns });
    console.log(`uploaded ${r.uploaded}, unchanged ${r.skipped} → ${store.kind}:${r.prefix}`);
    if (l.config.viewerURL) console.log(`viewer: ${l.config.viewerURL.replace(/\/$/, '')}/r/${r.prefix}`);
  });

program
  .command('comment [run]')
  .description('render the sticky PR comment markdown for a run locally (no GitHub calls)')
  .option('--body-file <file>', 'PR body with a Test Plan')
  .option('--head-sha <sha>')
  .option('--out <file>')
  .action(async (run: string | undefined, o) => {
    const l = await cfg();
    const dir = latestRun(l, run);
    const { summary, manifests } = loadRun(dir);
    const { resolved } = allScenarios(l);
    const items = o.bodyFile ? parseTestPlan(readFileSync(o.bodyFile, 'utf8')) : [];
    const md = renderComment({ summary, manifests, mappings: mapTestPlan(items, resolved.map((r) => ({ key: r.key, covers: r.covers }))), headSha: o.headSha });
    if (o.out) writeFileSync(o.out, md);
    else process.stdout.write(md);
  });

program
  .command('verify [run]')
  .description('re-hash every artifact against its manifest; flag stale evidence')
  .option('--head-sha <sha>')
  .action(async (run: string | undefined, o) => {
    const l = await cfg();
    const dir = latestRun(l, run);
    const { summary } = loadRun(dir);
    let bad = 0;
    for (const s of summary.scenarios) {
      const v = await verifyBundle(join(dir, s.dir), o.headSha);
      console.log(`${v.ok ? '✅' : '❌'} ${s.key}${v.stale ? ' (stale)' : ''}${v.ok ? '' : ': ' + v.artifacts.filter((a) => !a.ok).map((a) => `${a.path} ${a.reason}`).join(', ')}`);
      if (!v.ok || v.stale) bad++;
    }
    process.exitCode = bad ? 1 : 0;
  });

program
  .command('viewer')
  .description('serve the self-hosted viewer over the configured store')
  .option('--port <n>', 'port', '4400')
  .option('--host <h>', 'bind address', '127.0.0.1')
  .option('--auth <mode>', 'none | token | header', process.env.RECEIPTS_VIEWER_TOKEN ? 'token' : 'none')
  .option('--allowed-domains <list>', 'header mode: comma-separated email domains')
  .option('--allowed-groups <list>', 'header mode: comma-separated groups (e.g. GitHub org teams from oauth2-proxy)')
  .option('--trusted-proxies <list>', 'header mode: proxy IPs allowed to set identity headers (default loopback)')
  .option('--presign', 'redirect media to short-lived signed URLs (S3)')
  .option('--audit-log <file>', 'JSONL audit log', '.receipts/audit.log')
  .action(async (o) => {
    const l = await cfg();
    const store = createStore(l.config.store ?? { type: 'fs', dir: '.receipts/store' }, l.root);
    const split = (s?: string) => s?.split(',').map((x) => x.trim()).filter(Boolean);
    let auth: AuthConfig;
    if (o.auth === 'token') {
      const token = process.env.RECEIPTS_VIEWER_TOKEN ?? '';
      if (token.length < 16) throw new Error('set RECEIPTS_VIEWER_TOKEN (16+ chars) for token auth');
      auth = { mode: 'token', token };
    } else if (o.auth === 'header') auth = { mode: 'header', allowedDomains: split(o.allowedDomains), allowedGroups: split(o.allowedGroups), trustedProxies: split(o.trustedProxies) };
    else {
      if (!['127.0.0.1', 'localhost', '::1'].includes(o.host)) throw new Error('auth "none" is only allowed on loopback; use --auth token or header');
      auth = { mode: 'none' };
    }
    const srv = createViewer({ store, auth, presign: o.presign, auditLog: resolve(l.root, o.auditLog) });
    srv.listen(Number(o.port), o.host, () => console.log(`Receipts viewer on http://${o.host}:${o.port} (auth: ${auth.mode}, store: ${store.kind})${auth.mode === 'token' ? `\nopen http://${o.host}:${o.port}/login?token=… once to set the cookie` : ''}`));
  });

program
  .command('doctor')
  .description('check config, app health, personas, flags, redaction and tooling')
  .action(async () => {
    const l = await cfg();
    const ok = (b: boolean, s: string) => console.log(`${b ? '✅' : '⚠️ '} ${s}`);
    ok(!!l.file, `config: ${l.file ? rel(l, l.file) : 'none (using defaults)'}`);
    ok(Number(process.versions.node.split('.')[0]) >= 20, `node ${process.version}`);
    const health = l.config.webServer?.url ?? l.config.baseURL;
    ok(await isUp(health), `app reachable at ${health}${l.config.webServer ? ' (webServer will start it if not)' : ''}`);
    const { resolved } = allScenarios(l);
    ok(resolved.length > 0, `${resolved.length} runnable scenario(s) in ${rel(l, l.scenariosDir)}`);
    ok(await hasFfmpeg(), 'ffmpeg (WebM → MP4 with chapters; optional)');
    ok(!!traceViewerDir(), 'Playwright trace viewer bundled for the viewer');
    try {
      const { chromium } = await import('@receipts/core');
      const b = await chromium.launch();
      ok(true, `chromium ${b.version()}`);
      for (const name of Object.keys(l.config.personas ?? {})) {
        try {
          if (await isUp(health)) {
            await ensurePersonaState(b, l, name, l.config.baseURL, true);
            ok(true, `persona "${name}" signs in`);
          }
        } catch (e) {
          ok(false, `persona "${name}": ${(e as Error).message}`);
        }
      }
      await b.close();
    } catch (e) {
      ok(false, `chromium: ${(e as Error).message.split('\n')[0]} (run: npx playwright install chromium)`);
    }
    ok(!!l.config.flags?.adapters.length, `flag adapters: ${(l.config.flags?.adapters ?? []).map((a) => a.type).join(', ') || 'none'}`);
    ok(!!l.config.redact?.selectors?.length, `redaction selectors: ${(l.config.redact?.selectors ?? []).join(', ') || 'none (only [data-receipts-redact])'}`);
    ok(true, `AI provider: ${resolveProvider(l.config.ai) ? resolveProvider(l.config.ai)!.name : 'off'}; judge ${l.config.ai?.judge?.enabled ? 'enabled' : 'off'}`);
  });

program
  .command('purge')
  .description('delete local runs (and store objects for a PR)')
  .option('--older-than <days>', 'local runs older than N days', '30')
  .option('--pr <n>', 'also delete store objects under */pr-<n>/')
  .action(async (o) => {
    const l = await cfg();
    const cutoff = Date.now() - Number(o.olderThan) * 86400_000;
    let n = 0;
    if (existsSync(l.runsDir))
      for (const d of readdirSync(l.runsDir)) {
        const p = join(l.runsDir, d);
        if (statSync(p).isDirectory() && statSync(p).mtimeMs < cutoff) {
          rmSync(p, { recursive: true, force: true });
          n++;
        }
      }
    console.log(`removed ${n} local run(s)`);
    if (o.pr && l.config.store) {
      const store = createStore(l.config.store, l.root);
      const keys = (await store.list('')).filter((k) => k.includes(`/pr-${o.pr}/`));
      const prefixes = [...new Set(keys.map((k) => k.slice(0, k.indexOf(`/pr-${o.pr}/`) + `/pr-${o.pr}/`.length)))];
      let del = 0;
      for (const p of prefixes) del += await store.deletePrefix(p);
      console.log(`deleted ${del} store object(s) for PR #${o.pr}`);
    }
  });

program
  .command('ci')
  .description('GitHub Action entrypoint: run, publish, render check + sticky comment')
  .option('--event <file>', 'GitHub event payload', process.env.GITHUB_EVENT_PATH)
  .option('--body-file <file>', 'override the PR body')
  .option('--scenarios <list...>')
  .option('--all')
  .option('--base-url <url>')
  .option('--dry-run', 'write comment/check files; never call the GitHub API')
  .option('--comment-out <file>')
  .option('--check-out <file>')
  .option('--annotate-pr-body')
  .option('--no-publish')
  .option('--link-base <url>', 'link evidence to a local `receipts open --serve` viewer (dry runs)')
  .option('--no-fail', 'exit 0 even when scenarios fail')
  .action(async (o) => {
    const token = o.dryRun ? undefined : process.env.RECEIPTS_GITHUB_TOKEN ?? process.env.GITHUB_TOKEN;
    const r = await runCi({
      cwd: process.cwd(),
      eventPath: o.event,
      bodyFile: o.bodyFile,
      scenarios: o.scenarios,
      all: o.all,
      baseURL: o.baseUrl,
      dryRun: !!o.dryRun || !token,
      commentOut: o.commentOut,
      checkOut: o.checkOut,
      publish: o.publish,
      annotatePrBody: o.annotatePrBody,
      linkBase: o.linkBase,
      token,
    });
    console.log(`conclusion: ${r.conclusion}${r.githubCalls ? ` · ${r.githubCalls} GitHub API call(s)` : ' · 0 GitHub API calls'}`);
    if (r.conclusion === 'failure' && o.fail) process.exitCode = 1;
  });

program.parseAsync().catch((e) => {
  console.error(`receipts: ${(e as Error).message}`);
  process.exit(1);
});
