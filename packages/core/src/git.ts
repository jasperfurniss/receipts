import { execFileSync } from 'node:child_process';

export interface GitInfo {
  sha: string;
  shortSha: string;
  branch?: string;
  dirty: boolean;
  remote?: string;
}

function git(args: string[], cwd: string): string | undefined {
  try {
    return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return undefined;
  }
}

export function gitInfo(cwd: string): GitInfo {
  const sha = process.env.RECEIPTS_SHA || process.env.GITHUB_SHA_HEAD || git(['rev-parse', 'HEAD'], cwd) || 'unknown';
  const dirtyOut = git(['status', '--porcelain', '--untracked-files=no'], cwd);
  return {
    sha,
    shortSha: sha.slice(0, 7),
    branch: process.env.GITHUB_HEAD_REF || git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd),
    dirty: !!dirtyOut,
    remote: git(['config', '--get', 'remote.origin.url'], cwd),
  };
}

export function repoSlug(remote?: string): string | undefined {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  if (!remote) return undefined;
  const m = /[:/]([^/:]+\/[^/]+?)(\.git)?$/.exec(remote);
  return m?.[1];
}
