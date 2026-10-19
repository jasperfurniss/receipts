import { appendFileSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import {
  annotateTestPlan,
  createStore,
  findScenarioFiles,
  loadConfig,
  loadScenarioFile,
  mapTestPlan,
  parseTestPlan,
  publishRun,
  renderCheck,
  renderComment,
  runScenarios,
  selectScenarios,
  writeLocalReport,
  type Manifest,
  type ResolvedScenario,
} from '@receipts/core';
import { GitHubClient } from './github.js';

export interface CiOptions {
  cwd: string;
  /** Path to the GitHub event payload ($GITHUB_EVENT_PATH). */
  eventPath?: string;
  /** Explicit PR body file (overrides the event). */
  bodyFile?: string;
  scenarios?: string[];
  /** Run everything instead of changed + Test Plan-mapped + @smoke. */
  all?: boolean;
  baseURL?: string;
  /** Write the comment / check to files instead of calling GitHub. Default: true unless a token is given. */
  dryRun?: boolean;
  commentOut?: string;
  checkOut?: string;
  publish?: boolean;
  annotatePrBody?: boolean;
  /** Link evidence to a local runs viewer (`receipts open --serve`) when nothing is published, e.g. for dry runs. */
  linkBase?: string;
  token?: string;
  apiUrl?: string;
  fetchImpl?: typeof fetch;
  log?: (s: string) => void;
}

export interface CiResult {
  conclusion: 'success' | 'failure' | 'neutral';
  runDir?: string;
  commentFile?: string;
  checkFile?: string;
  comment: string;
  selected: string[];
  published?: string;
  githubCalls: number;
}

function changedFiles(cwd: string, base?: string, head?: string): string[] {
  if (!base || /^0+$/.test(base)) return [];
  try {
    return execFileSync('git', ['diff', '--name-only', `${base}...${head ?? 'HEAD'}`], { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .split('\n')
      .filter(Boolean)
      .map((f) => resolve(cwd, f));
  } catch {
    return [];
  }
}

export async function runCi(o: CiOptions): Promise<CiResult> {
  const log = o.log ?? ((s: string) => console.log(s));
  const loaded = await loadConfig(o.cwd);
  const event = o.eventPath ? JSON.parse(readFileSync(o.eventPath, 'utf8')) : {};
  const pr = event.pull_request ?? {};
  const prNumber: number | undefined = pr.number ?? event.number;
  const repo: string | undefined = event.repository?.full_name ?? process.env.GITHUB_REPOSITORY ?? loaded.config.repo;
  const headSha: string | undefined = pr.head?.sha ?? process.env.GITHUB_SHA;
  const body: string = o.bodyFile ? readFileSync(o.bodyFile, 'utf8') : pr.body ?? '';
  const isFork = !!pr.head?.repo && !!pr.base?.repo && pr.head.repo.full_name !== pr.base.repo.full_name;
  const dryRun = o.dryRun ?? !o.token;

  const files = findScenarioFiles(loaded.scenariosDir);
  const all: ResolvedScenario[] = files.flatMap((f) => loadScenarioFile(f).resolved);
  const items = parseTestPlan(body);
  const mappings = mapTestPlan(items, all.map((r) => ({ key: r.key, covers: r.covers })));

  let selected: ResolvedScenario[];
  if (o.scenarios?.length) selected = selectScenarios(all, o.scenarios);
  else if (o.all) selected = all;
  else {
    const changed = new Set(changedFiles(o.cwd, pr.base?.sha, headSha));
    const mapped = new Set(mappings.flatMap((m) => m.scenarios.map((s) => s.key)));
    selected = all.filter((r) => mapped.has(r.key) || r.tags.includes('smoke') || (r.sourceFile && changed.has(resolve(r.sourceFile))));
  }
  log(`receipts ci: ${selected.length}/${all.length} scenario(s) selected; ${items.length} Test Plan item(s); dry-run=${dryRun}${isFork ? ' (fork PR: local artifacts only)' : ''}`);

  const gh = !dryRun && o.token && repo ? new GitHubClient(o.token, repo, o.apiUrl, o.fetchImpl) : undefined;
  let githubCalls = 0;
  if (gh && prNumber && headSha) {
    await gh.markStale(prNumber, headSha);
    githubCalls++;
  }

  let manifests: Manifest[] = [];
  let runDir: string | undefined;
  let summary;
  if (selected.length) {
    const r = await runScenarios(loaded, selected, { baseURL: o.baseURL, log });
    runDir = r.runDir;
    summary = r.summary;
    manifests = r.results.map((x) => x.manifest);
    if (prNumber) {
      summary.pr = { number: prNumber, repo, headSha };
      writeFileSync(join(runDir, 'run.json'), JSON.stringify(summary, null, 2));
    }
    writeLocalReport(runDir);
  }

  let published: string | undefined;
  const viewer = loaded.config.viewerURL?.replace(/\/$/, '');
  if (runDir && o.publish !== false && loaded.config.store && !isFork) {
    const store = createStore(loaded.config.store, loaded.root);
    const p = await publishRun(runDir, store, { repo, pr: prNumber, patterns: loaded.config.redact?.patterns });
    published = p.prefix;
    log(`published ${p.uploaded} file(s) (${p.skipped} unchanged) to ${store.kind}:${p.prefix}`);
  }
  const runUrl = process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL ?? 'https://github.com'}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}` : undefined;
  const base = published && viewer ? `${viewer}/r/${published}` : o.linkBase && summary ? `${o.linkBase.replace(/\/$/, '')}/r/${summary.runId}/` : undefined;
  const link = base
    ? (m: Manifest, anchor?: string) => {
        const dir = summary!.scenarios.find((s) => s.key === m.key)!.dir;
        return `${base}#${dir}${anchor ? `-${anchor}` : ''}`;
      }
    : undefined;

  const privacyNote = !published && o.linkBase ? 'Dry run: links point to a local viewer (`receipts open --serve`); nothing was uploaded.' : undefined;
  const input = { summary: summary ?? emptySummary(), manifests, mappings, headSha, link, expiresDays: published ? 30 : undefined, artifactUrl: runUrl, privacyNote };
  const comment = renderComment(input);
  const check = renderCheck(input);

  const outDir = runDir ?? join(loaded.outDir, 'ci');
  const commentFile = o.commentOut ? resolve(o.cwd, o.commentOut) : join(outDir, 'pr-comment.md');
  const checkFile = o.checkOut ? resolve(o.cwd, o.checkOut) : join(outDir, 'check-run.json');
  mkdirSync(dirname(commentFile), { recursive: true });
  mkdirSync(dirname(checkFile), { recursive: true });
  writeFileSync(commentFile, comment);
  writeFileSync(checkFile, JSON.stringify({ head_sha: headSha, ...check }, null, 2));

  if (o.annotatePrBody && body) {
    const results: Record<string, 'passed' | 'failed'> = {};
    for (const m of manifests) results[m.key] = m.status === 'passed' ? 'passed' : 'failed';
    const next = annotateTestPlan(body, mappings, results, (k) => (link ? link(manifests.find((m) => m.key === k)!) ?? '#' : runUrl ?? '#'));
    writeFileSync(join(outDir, 'pr-body.annotated.md'), next);
    if (gh && prNumber && next !== body) {
      await gh.updatePrBody(prNumber, next);
      githubCalls++;
    }
  }

  if (gh && prNumber && headSha) {
    await gh.upsertComment(prNumber, comment);
    await gh.createCheck(headSha, check, link && manifests[0] ? link(manifests[0]) : runUrl);
    githubCalls += 2;
  } else log(`dry-run: comment → ${relative(o.cwd, commentFile)}, check → ${relative(o.cwd, checkFile)}`);

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `conclusion=${check.conclusion}\nrun-dir=${runDir ?? ''}\ncomment-file=${commentFile}\n`);
  }
  return { conclusion: check.conclusion, runDir, commentFile, checkFile, comment, selected: selected.map((s) => s.key), published, githubCalls };

  function emptySummary() {
    return {
      schema: 'receipts.run/v1' as const,
      runId: 'none',
      createdAt: new Date().toISOString(),
      git: { sha: headSha ?? 'unknown', shortSha: (headSha ?? 'unknown').slice(0, 7), dirty: false },
      baseURL: loaded.config.baseURL,
      browser: 'chromium',
      durationMs: 0,
      scenarios: [],
      totals: { passed: 0, failed: 0 },
    };
  }
}
