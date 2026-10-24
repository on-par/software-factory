// packages/core/src/worktree/worktree-name.ts — lane worktree directory naming (#1709).
import { workKeyFromIssue, type WorkKey } from '../work/work-key.js';
import { branchPrefixSlug, factoryBranchPrefixes } from '../utils/index.js';

/** Fixed ownership infix; worktree-gc matches it as `${repoBase}-factory-`. */
const WORKTREE_MARKER = 'factory';

/** Basename of a lane worktree dir: `<repoBase>-factory-<prefixSlug>-<key>`, skipping a segment
 *  the name already ends with so the default `factory` prefix never yields `factory-factory` (#1709). */
export function worktreeDirName(repoBase: string, key: WorkKey, prefix?: string): string {
  let name = repoBase;
  for (const segment of [WORKTREE_MARKER, branchPrefixSlug(prefix)]) {
    if (name === segment || name.endsWith(`-${segment}`)) continue;
    name = `${name}-${segment}`;
  }
  return `${name}-${key}`;
}

/** Pre-#2763 lane name, kept only so existing checkouts are still found and reaped. */
export function legacyWorktreeDirName(repoBase: string, key: WorkKey, prefix?: string): string {
  return `${repoBase}-${WORKTREE_MARKER}-${branchPrefixSlug(prefix)}-${key}`;
}

/** GC ownership by basename: the `${repoBase}-factory-` infix, or (#2763) an exact worktreeDirName match, since
 *  deduped names can lack the infix (software-factory + factory → software-factory-<n>); that one also needs a
 *  detached or lane branch so manual worktrees are never claimed. */
export function isFactoryDirName(
  repoBase: string,
  base: string,
  branch: string | null,
  branchPrefix?: string,
): boolean {
  if (base.startsWith(`${repoBase}-${WORKTREE_MARKER}-`)) return true;
  const n = base.match(/-(\d+)$/)?.[1];
  if (n === undefined) return false;
  return factoryBranchPrefixes(branchPrefix).some(
    (p) =>
      worktreeDirName(repoBase, workKeyFromIssue(Number(n)), p) === base &&
      (branch === null || new RegExp(`^${p}/\\d+-`).test(branch)),
  );
}
