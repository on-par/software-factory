// packages/core/src/utils/worktree-name.ts — lane worktree directory naming (#1709).
import { branchPrefixSlug } from './index.js';

/** Fixed ownership infix; worktree-gc matches it as `${repoBase}-factory-`. */
const WORKTREE_MARKER = 'factory';

/** Basename of a lane worktree dir: `<repoBase>-factory-<prefixSlug>-<issue>`, skipping a segment
 *  the name already ends with so the default `factory` prefix never yields `factory-factory` (#1709). */
export function worktreeDirName(repoBase: string, issue: number, prefix?: string): string {
  let name = repoBase;
  for (const segment of [WORKTREE_MARKER, branchPrefixSlug(prefix)]) {
    if (name === segment || name.endsWith(`-${segment}`)) continue;
    name = `${name}-${segment}`;
  }
  return `${name}-${issue}`;
}
