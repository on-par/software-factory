import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { WorkKey } from '../work/work-key.js';
import { execGit } from './git-exec.js';
import { legacyWorktreeDirName, worktreeDirName } from './worktree-name.js';

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

export function laneWorktreePath(opts: {
  repoRoot: string;
  parent: string;
  repo: string;
  key: WorkKey;
  prefix?: string;
  home?: string;
  exists?: (path: string) => boolean;
}): string {
  const { repoRoot, parent, repo, key, prefix, home, exists = existsSync } = opts;
  const repoBase = basename(resolve(repoRoot));
  const root = resolveWorktreeRoot({ repoRoot, parent, repo, home });
  const sibling = dirname(resolve(repoRoot));
  const names = [...new Set([worktreeDirName(repoBase, key, prefix), legacyWorktreeDirName(repoBase, key, prefix)])];
  const primary = join(root, names[0]!);
  const fallbacks = [...names.slice(1).map((n) => join(root, n)), ...names.map((n) => join(sibling, n))];
  if (exists(primary)) return primary;
  return fallbacks.find((p) => p !== primary && exists(p)) ?? primary;
}

function readExcludeFileOrEmpty(file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

export async function ensureWorktreeParentExcluded(repoRoot: string, worktreeParent: string): Promise<boolean> {
  const rel = relative(resolve(repoRoot), resolve(worktreeParent));
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return false;
  const { stdout } = await execGit(['rev-parse', '--git-path', 'info/exclude'], { cwd: repoRoot });
  const file = resolve(repoRoot, stdout.trim());
  const line = `/${rel.split(sep).join('/')}/`;
  const existing = readExcludeFileOrEmpty(file);
  const lines = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
  if (lines.has(line) || lines.has('/.factory/') || lines.has('.factory/')) return false;
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${existing === '' || existing.endsWith('\n') ? '' : '\n'}${line}\n`);
  return true;
}

export function formatWorktreeLocation(root: string, parent: string): string {
  return `Worktrees: ${root}  (worktree.parent: ${parent})`;
}
