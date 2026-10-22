// packages/core/src/run/ci-base-sync.ts — merge origin/<base> into the lane worktree before a CI rework round (#3537)

import { execGit } from '../utils/git-exec.js';

export type BaseMergeResult = { ok: true; merged: boolean } | { ok: false; conflicts: string[]; message: string };

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Fetches origin/<baseRef> and merges it into the worktree's branch without pushing. A failed merge is
 * aborted so the worktree is never left mid-merge; unmerged paths come back as `conflicts`.
 */
export async function mergeBaseIntoWorktree(worktree: string, baseRef: string): Promise<BaseMergeResult> {
  const cwd = worktree;
  try {
    await execGit(['fetch', 'origin', baseRef], { cwd });
  } catch (err) {
    return { ok: false, conflicts: [], message: `could not fetch origin/${baseRef}: ${errorMessage(err)}` };
  }
  const before = (await execGit(['rev-parse', 'HEAD'], { cwd })).stdout.trim();
  try {
    await execGit(['merge', '--no-edit', `origin/${baseRef}`], { cwd });
  } catch (err) {
    let conflicts: string[] = [];
    try {
      const { stdout } = await execGit(['ls-files', '--unmerged'], { cwd });
      conflicts = [
        ...new Set(
          stdout
            .split('\n')
            .filter(Boolean)
            .map((line) => line.slice(line.indexOf('\t') + 1)),
        ),
      ].sort();
    } catch {
      // unmerged paths are best-effort
    }
    let abortNote = '';
    try {
      await execGit(['merge', '--abort'], { cwd });
    } catch (abortErr) {
      abortNote = ` (merge --abort failed: ${errorMessage(abortErr)})`;
    }
    const message =
      conflicts.length > 0
        ? `merging origin/${baseRef} conflicted: ${conflicts.join(', ')}`
        : `could not merge origin/${baseRef}: ${errorMessage(err)}`;
    return { ok: false, conflicts, message: message + abortNote };
  }
  const after = (await execGit(['rev-parse', 'HEAD'], { cwd })).stdout.trim();
  return { ok: true, merged: after !== before };
}
