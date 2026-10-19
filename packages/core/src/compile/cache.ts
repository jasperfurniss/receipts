import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sha256 } from '../hash.js';

export interface CompiledStep {
  instruction: string;
  code: string;
  source: 'llm' | 'manual';
  provider?: string;
  createdAt: string;
}
export type StepCache = Record<string, CompiledStep>;

export const stepHash = (instruction: string) => sha256(instruction.trim().replace(/\s+/g, ' ')).slice(0, 16);
export const stepCachePath = (compiledDir: string) => join(compiledDir, 'steps.json');

export function readStepCache(compiledDir: string): StepCache {
  const p = stepCachePath(compiledDir);
  if (!existsSync(p)) return {};
  return JSON.parse(readFileSync(p, 'utf8')) as StepCache;
}
export function writeStepCache(compiledDir: string, cache: StepCache) {
  const p = stepCachePath(compiledDir);
  mkdirSync(dirname(p), { recursive: true });
  const sorted: StepCache = {};
  for (const k of Object.keys(cache).sort()) sorted[k] = cache[k]!;
  writeFileSync(p, JSON.stringify(sorted, null, 2) + '\n');
}
