import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import YAML from 'yaml';
import { ScenarioSchema, type Scenario, type ResolvedScenario, type Step, type Variant, type Assertion } from './schema.js';
import { canonicalJson, sha256 } from '../hash.js';

export class ScenarioError extends Error {
  constructor(message: string, public file?: string) {
    super(file ? `${file}: ${message}` : message);
  }
}

export function normalizeFlagValue(v: unknown): boolean | string {
  if (v === true || v === false) return v;
  const s = String(v).trim().toLowerCase();
  if (['on', 'true', 'yes', 'enabled', '1'].includes(s)) return true;
  if (['off', 'false', 'no', 'disabled', '0'].includes(s)) return false;
  return String(v);
}
function normalizeFlags(f: Record<string, unknown> | undefined): Record<string, boolean | string> {
  const out: Record<string, boolean | string> = {};
  for (const [k, v] of Object.entries(f ?? {})) out[k] = normalizeFlagValue(v);
  return out;
}

/** Parse YAML text into a validated Scenario. */
export function parseScenario(text: string, file?: string): Scenario {
  let raw: unknown;
  try {
    // YAML 1.2 core schema: `on`/`off` stay strings, which we normalize ourselves.
    raw = YAML.parse(text);
  } catch (e) {
    throw new ScenarioError(`invalid YAML: ${(e as Error).message}`, file);
  }
  const res = ScenarioSchema.safeParse(raw);
  if (!res.success) {
    const msg = res.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
    throw new ScenarioError(`invalid scenario:\n${msg}`, file);
  }
  const s = res.data;
  const stepIds = new Set<string>();
  for (const st of [...s.setup, ...s.steps]) {
    if (st.id) {
      if (stepIds.has(st.id)) throw new ScenarioError(`duplicate step id "${st.id}"`, file);
      stepIds.add(st.id);
    }
    if (Object.keys(st).length === 0) throw new ScenarioError('empty step', file);
  }
  const varIds = new Set<string>();
  for (const v of s.variants) {
    if (varIds.has(v.id)) throw new ScenarioError(`duplicate variant id "${v.id}"`, file);
    varIds.add(v.id);
    for (const id of [...Object.keys(v.override_steps ?? {}), ...(v.skip_steps ?? [])]) {
      if (!stepIds.has(id)) throw new ScenarioError(`variant "${v.id}" references unknown step id "${id}"`, file);
    }
  }
  return s;
}

const TEMPLATE = /\{\{\s*([\w.-]+)\s*\}\}/g;
export function applyTemplate<T>(value: T, vars: Record<string, string>, env: NodeJS.ProcessEnv = process.env): T {
  if (typeof value === 'string') {
    return value.replace(TEMPLATE, (m, name: string) => {
      if (name.startsWith('env.')) return env[name.slice(4)] ?? '';
      if (name in vars) return vars[name]!;
      throw new ScenarioError(`unknown template variable {{${name}}}`);
    }) as T;
  }
  if (Array.isArray(value)) return value.map((v) => applyTemplate(v, vars, env)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = applyTemplate(v, vars, env);
    return out as T;
  }
  return value;
}

function isConsoleOnly(expect: Assertion[] | undefined) {
  return !!expect && expect.length > 0 && expect.every((a) => 'console' in a);
}

function applyVariant(s: Scenario, v: Variant): { steps: Step[]; setup: Step[] } {
  const skip = new Set(v.skip_steps ?? []);
  let steps = s.steps.filter((st) => !st.id || !skip.has(st.id)).map((st) => ({ ...st }));
  const setup = s.setup.filter((st) => !st.id || !skip.has(st.id)).map((st) => ({ ...st }));
  for (const [id, patch] of Object.entries(v.override_steps ?? {})) {
    const idx = steps.findIndex((st) => st.id === id);
    const target = idx >= 0 ? steps : setup;
    const i = idx >= 0 ? idx : setup.findIndex((st) => st.id === id);
    if (i < 0) continue;
    target[i] = { ...target[i], ...patch } as Step;
  }
  if (v.override_last_expect) {
    let i = -1;
    for (let j = steps.length - 1; j >= 0; j--) {
      if (steps[j]!.expect && !isConsoleOnly(steps[j]!.expect)) { i = j; break; }
    }
    if (i < 0) throw new ScenarioError(`variant "${v.id}": override_last_expect but no step has expectations`);
    steps[i] = { ...steps[i]!, expect: v.override_last_expect };
  }
  return { steps, setup };
}

/** Expand a scenario into its base run plus one run per variant. */
export function resolveScenario(s: Scenario, opts: { file?: string; env?: NodeJS.ProcessEnv } = {}): ResolvedScenario[] {
  const out: ResolvedScenario[] = [];
  const make = (v?: Variant): ResolvedScenario => {
    const fixtures = { ...s.fixtures, ...(v?.fixtures ?? {}) };
    const { steps, setup } = v ? applyVariant(s, v) : { steps: s.steps, setup: s.setup };
    const body = {
      key: v ? `${s.id}/${v.id}` : s.id,
      scenarioId: s.id,
      variantId: v?.id,
      title: v?.title ?? (v ? `${s.title} (${v.id})` : s.title),
      description: s.description,
      tags: [...new Set([...s.tags, ...(v?.tags ?? [])])],
      covers: v ? v.covers ?? [] : s.covers,
      persona: v?.persona ?? s.persona,
      flags: { ...normalizeFlags(s.flags), ...normalizeFlags(v?.flags) },
      viewport: s.viewport,
      baseURL: s.baseURL,
      fixtures,
      setup: applyTemplate(setup, fixtures, opts.env),
      steps: applyTemplate(steps, fixtures, opts.env),
      redact: s.redact,
      timeout: s.timeout,
    };
    return { ...body, sourceFile: opts.file, hash: sha256(canonicalJson(body)) };
  };
  out.push(make());
  for (const v of s.variants) out.push(make(v));
  return out;
}

export function loadScenarioFile(file: string, env?: NodeJS.ProcessEnv): { scenario: Scenario; resolved: ResolvedScenario[]; source: string } {
  const source = readFileSync(file, 'utf8');
  const scenario = parseScenario(source, file);
  return { scenario, resolved: resolveScenario(scenario, { file, env }), source };
}

export function findScenarioFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.ya?ml$/.test(name)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

/**
 * Select resolved scenarios by key/glob/tag. Patterns: `video-resume`, `video-resume/flag-off`,
 * `video-*`, `@smoke`. A bare scenario id selects the base run plus all its variants.
 */
export function selectScenarios(all: ResolvedScenario[], patterns: string[]): ResolvedScenario[] {
  if (patterns.length === 0) return all;
  const res: ResolvedScenario[] = [];
  for (const r of all) {
    const hit = patterns.some((p) => {
      if (p.startsWith('@')) return r.tags.includes(p.slice(1));
      const re = new RegExp('^' + p.split('*').map(escapeRe).join('.*') + '$');
      return re.test(r.key) || re.test(r.scenarioId) || (r.sourceFile ? resolve(r.sourceFile) === resolve(p) : false);
    });
    if (hit) res.push(r);
  }
  return res;
}
function escapeRe(s: string) {
  return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

export function relativeTo(root: string, p?: string) {
  return p ? relative(root, p) : undefined;
}
