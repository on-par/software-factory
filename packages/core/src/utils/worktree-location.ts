// packages/core/src/utils/worktree-location.ts — where lane worktrees live (#1758).
import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { execGit } from './git-exec.js';
import { branchPrefixSlug } from './index.js';

/** Root directory lane worktrees are created under. A `~` or absolute parent is a shared
 *  root and is namespaced `<owner>/<repo>`; a repo-relative parent is used as-is. */
export function resolveWorktreeRoot(opts: { repoRoot: string; parent: string; repo: string; home?: string }): string {
  const { repoRoot, parent, repo, home = homedir() } = opts;
  let base: string;
  if (parent === '~') {
    base = home;
  } else if (parent.startsWith('~/')) {
    base = join(home, parent.slice(2));
  } else if (isAbsolute(parent)) {
    base = parent;
  } else {
    return resolve(repoRoot, parent);
  }
  const [owner, name] = repo.split('/');
  return owner && name ? join(base, owner, name) : join(base, basename(resolve(repoRoot)));
}

/** Absolute lane worktree path. Falls back to the legacy sibling path when only that exists,
 *  so in-flight lanes keep their checkout. The basename never changes (GC matches on it). */
export function laneWorktreePath(opts: {
  repoRoot: string;
  parent: string;
  repo: string;
  issue: number;
  prefix?: string;
  home?: string;
  exists?: (path: string) => boolean;
}): string {
  const { repoRoot, parent, repo, issue, prefix, home, exists = existsSync } = opts;
  const dirName = `${basename(resolve(repoRoot))}-factory-${branchPrefixSlug(prefix)}-${issue}`;
  const primary = join(resolveWorktreeRoot({ repoRoot, parent, repo, home }), dirName);
  const legacy = join(dirname(resolve(repoRoot)), dirName);
  return !exists(primary) && primary !== legacy && exists(legacy) ? legacy : primary;
}

/** Adds an in-repo worktree parent to the repo's info/exclude. Returns true when a line was
 *  written; false when the parent is outside the repo or already covered. */
export async function ensureWorktreeParentExcluded(repoRoot: string, worktreeParent: string): Promise<boolean> {
  const rel = relative(resolve(repoRoot), resolve(worktreeParent));
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return false;
  const { stdout } = await execGit('git rev-parse --git-path info/exclude', { cwd: repoRoot });
  const file = resolve(repoRoot, stdout.trim());
  const line = `/${rel.split(sep).join('/')}/`;
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const lines = existing.split(/\r?\n/).map((l) => l.trim());
  if (lines.includes(line) || lines.includes('/.factory/') || lines.includes('.factory/')) return false;
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${existing === '' || existing.endsWith('\n') ? '' : '\n'}${line}\n`);
  return true;
}

export function formatWorktreeLocation(root: string, parent: string): string {
  return `Worktrees: ${root}  (worktree.parent: ${parent})`;
}
