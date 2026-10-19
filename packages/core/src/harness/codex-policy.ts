// Workspace-write paths and GitHub egress for Codex tasks.

import { isAbsolute, relative, resolve } from 'node:path';

import type { TaskType } from '../types/index.js';

/** Tasks whose prompts may use gh or publish a branch. CHECK and CI rework reuse
 * build_claude; the other build routes explicitly prohibit pushing. */
export const CODEX_GITHUB_NETWORK_TASKS: ReadonlySet<TaskType> = new Set<TaskType>(['plan', 'build_claude']);

/** Exact GitHub endpoints used by gh, git HTTPS and common repository downloads. */
export const CODEX_GITHUB_HOSTS = [
  'github.com',
  'api.github.com',
  'uploads.github.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
  'raw.githubusercontent.com',
] as const;

/** Normalize factory roots and refuse any path that contains the primary checkout. */
export function codexWritableRoots(
  roots: readonly string[] | undefined,
  worktree: string,
  primaryRepoRoot: string | undefined,
): { roots: string[]; rejected: boolean } {
  const repo = primaryRepoRoot && isAbsolute(primaryRepoRoot) ? resolve(primaryRepoRoot) : undefined;
  if (roots?.length && !repo) return { roots: [], rejected: true };
  const kept = new Set<string>();
  let rejected = false;
  for (const path of roots ?? []) {
    if (!isAbsolute(path)) {
      rejected = true;
      continue;
    }
    const root = resolve(path);
    const fromRootToRepo = repo === undefined ? undefined : relative(root, repo);
    if (fromRootToRepo !== undefined && !fromRootToRepo.startsWith('..') && !isAbsolute(fromRootToRepo)) {
      rejected = true;
      continue;
    }
    if (root !== resolve(worktree)) kept.add(root);
  }
  return { roots: [...kept], rejected };
}
