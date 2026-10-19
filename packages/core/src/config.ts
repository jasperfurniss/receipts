import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { BrowserContext, Page, APIRequestContext } from 'playwright';

export type FlagValue = boolean | string;
export type Flags = Record<string, FlagValue>;

export interface FlagContext {
  context: BrowserContext;
  baseURL: string;
  flags: Flags;
}

/** Built-in and custom ways to force feature flags for a run. */
export type FlagAdapterConfig =
  | { type: 'cookie'; name: string; encode?: 'json' | 'csv' | ((flags: Flags) => string); domain?: string }
  | { type: 'localStorage'; key: string; encode?: 'json' | 'csv' | ((flags: Flags) => string) }
  | { type: 'query'; param: string; encode?: 'json' | 'csv' | ((flags: Flags) => string) }
  | { type: 'header'; name: string; encode?: 'json' | 'csv' | ((flags: Flags) => string) }
  | {
      type: 'route';
      /** URL glob of the flags API, e.g. `** /api/flags` */
      url: string;
      /** Rewrite the real JSON response. Default: shallow-merge `flags` into the response object. */
      transform?: (body: any, flags: Flags) => any;
    }
  | { type: 'custom'; apply: (ctx: FlagContext) => Promise<void> | void; transformUrl?: (url: string, flags: Flags) => string };

export interface FlagsConfig {
  adapters: FlagAdapterConfig[];
  /** Read the flag state the app actually resolved, recorded in the manifest. */
  readResolved?: (page: Page) => Promise<Record<string, unknown> | undefined>;
}

export interface SignInContext {
  context: BrowserContext;
  page: Page;
  request: APIRequestContext;
  baseURL: string;
  persona: string;
}

export interface PersonaConfig {
  label?: string;
  /** Path to an existing Playwright storageState JSON. */
  storageState?: string;
  /** API sign-in (no UI login in the video), or a function for anything custom. */
  signIn?:
    | { request: { method?: string; url: string; data?: unknown; headers?: Record<string, string> } }
    | ((ctx: SignInContext) => Promise<void>);
  /** Re-use the cached storageState for this long. Default 30 min. */
  maxAgeMinutes?: number;
}

export interface RedactConfig {
  /** CSS selectors to blur in-page (applies to video, screenshots, trace snapshots). */
  selectors?: string[];
  /** Elements with this attribute are always blurred. Default `data-receipts-redact`. */
  attribute?: string;
  style?: 'blur' | 'solid';
  /** Extra header names to strip from traces and logs (Authorization, Cookie, Set-Cookie are always stripped). */
  headers?: string[];
  /** Extra regex sources treated as secrets. */
  patterns?: string[];
  /** URL globs whose response bodies are dropped from the trace. */
  dropBodiesFor?: string[];
}

export interface JudgeRequest {
  expectation: string;
  /** PNG screenshots, already redacted. */
  images: Buffer[];
  context?: { url: string; scenario: string; step: string };
}
export interface JudgeVerdict {
  verdict: 'pass' | 'fail' | 'unsure';
  rationale: string;
  confidence?: 'low' | 'medium' | 'high';
}
export interface AiProvider {
  name: string;
  /** Judge a natural-language expectation against redacted screenshots. */
  judge?(req: JudgeRequest): Promise<JudgeVerdict>;
  /** Turn one natural-language step into Playwright code (body of `async (page) => { ... }`). */
  compileStep?(req: { instruction: string; ariaSnapshot?: string; url?: string }): Promise<string>;
  /** Draft a scenario YAML from a Test Plan item. */
  draftScenario?(req: { item: string; diff?: string; issue?: string }): Promise<string>;
}

export interface AiConfig {
  /** A provider object, or an OpenAI-compatible endpoint description. */
  provider?: AiProvider | { type: 'openai-compatible'; baseURL?: string; model: string; apiKeyEnv: string };
  judge?: { enabled?: boolean; /** Whether an AI `fail` fails the scenario. Default: warn only. */ canFail?: boolean };
}

export type StoreConfig =
  | { type: 'fs'; dir: string }
  | {
      type: 's3';
      bucket: string;
      region?: string;
      endpoint?: string;
      prefix?: string;
      forcePathStyle?: boolean;
      /** Env var names for static creds (local/dev). In CI prefer OIDC / the default credential chain. */
      accessKeyIdEnv?: string;
      secretAccessKeyEnv?: string;
    };

export interface ReceiptsConfig {
  baseURL: string;
  /** Where scenarios live. Default `.receipts/scenarios`. */
  scenariosDir?: string;
  /** Root of local state. Default `.receipts`. */
  outDir?: string;
  /** Refuse to record anything not on these hosts. Default localhost + *.local + *.internal + *.test. */
  allowHosts?: string[];
  viewport?: { width: number; height: number };
  headless?: boolean;
  /** Default per-assertion polling timeout (ms). Default 5000. */
  expectTimeout?: number;
  /** Default action timeout (ms). Default 10000. */
  actionTimeout?: number;
  video?: { enabled?: boolean; mp4?: boolean };
  /** Trace options. Screencast frames are off by default (the video already covers it; saves ~8 MB/scenario). */
  trace?: { screenshots?: boolean; /** Omit response bodies above this size and all audio/video bodies. Default 1 MiB, 0 keeps everything. */ maxBodyBytes?: number };
  /** Overlay a chapter card for each step in the video. Default true. */
  chapters?: { enabled?: boolean; holdMs?: number };
  webServer?: { command: string; url: string; timeout?: number; reuseExisting?: boolean; cwd?: string; env?: Record<string, string> };
  personas?: Record<string, PersonaConfig>;
  flags?: FlagsConfig;
  redact?: RedactConfig;
  ai?: AiConfig;
  store?: StoreConfig;
  /** Public (SSO-gated) viewer base URL used for links in PR comments. */
  viewerURL?: string;
  /** `org/repo`, used for the store layout. Defaults to $GITHUB_REPOSITORY or the git remote. */
  repo?: string;
}

export function defineConfig(c: ReceiptsConfig): ReceiptsConfig {
  return c;
}

export interface LoadedConfig {
  config: ReceiptsConfig;
  root: string;
  file?: string;
  scenariosDir: string;
  outDir: string;
  runsDir: string;
  compiledDir: string;
}

const NAMES = ['receipts.config.ts', 'receipts.config.mts', 'receipts.config.js', 'receipts.config.mjs'];

export function findConfigFile(start: string): string | undefined {
  let dir = resolve(start);
  for (;;) {
    for (const n of NAMES) if (existsSync(join(dir, n))) return join(dir, n);
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export async function loadConfig(cwd = process.cwd(), explicit?: string): Promise<LoadedConfig> {
  const file = explicit ? resolve(cwd, explicit) : findConfigFile(cwd);
  let config: ReceiptsConfig;
  if (file) {
    const { createJiti } = await import('jiti');
    // Resolve `@receipts/core` imports in the config to this copy, so a globally/npx-installed CLI works too.
    const { fileURLToPath } = await import('node:url');
    const self = fileURLToPath(new URL('./index.js', import.meta.url));
    const jiti = createJiti(import.meta.url, { moduleCache: false, alias: { '@receipts/core': self } });
    const mod = (await jiti.import(file, { default: true })) as ReceiptsConfig;
    config = mod;
  } else {
    config = { baseURL: 'http://localhost:3000' };
  }
  if (!config || typeof config.baseURL !== 'string') throw new Error(`${file ?? 'config'}: baseURL is required`);
  const root = file ? dirname(file) : resolve(cwd);
  const outDir = resolve(root, config.outDir ?? '.receipts');
  return {
    config,
    root,
    file,
    outDir,
    scenariosDir: resolve(root, config.scenariosDir ?? join(config.outDir ?? '.receipts', 'scenarios')),
    runsDir: join(outDir, 'runs'),
    compiledDir: join(outDir, 'compiled'),
  };
}
