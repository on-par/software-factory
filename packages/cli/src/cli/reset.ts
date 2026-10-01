// packages/cli/src/cli/reset.ts — `factory reset <issue...>`: remove an issue's local factory state (#1787);
// dirty/unpushed worktrees and branches are kept unless --force (#1789).

import { existsSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

import { LaneFileGuard, phaseSnapshotFile, type PortLease, ReworkHistory } from '@on-par/factory-core';
import {
  countUnpushedCommits,
  factoryBranchIssue,
  isWorktreeClean,
  parseWorktreeList,
} from '@on-par/factory-core/internal';

export interface ResetDeps {
  repoRoot: string;
  /** process.cwd() in prod — the worktree containing it is never removed. */
  cwd: string;
  paths: { plans: string; runs: string; logs: string; reworkHistory: string; laneFiles: string };
  branchPrefix?: string;
  /** Runs a shell command in repoRoot and returns stdout; throws on failure. */
  git: (cmd: string) => Promise<string>;
  removeWorktree: (path: string) => Promise<void>;
  readLeases: () => PortLease[];
  releaseLease: (worktreeId: string) => Promise<void>;
  /** Runs a command (cwd defaults to repoRoot in prod); used for the read-only dirty/unpushed probes. */
  runCommand: (cmd: string, opts?: { cwd?: string }) => Promise<{ stdout: string }>;
  /** Preview only: discover and report, never mutate. */
  dryRun?: boolean;
  /** Remove worktrees and branches even when dirty or unpushed (#1789). */
  force?: boolean;
}

export interface ResetResult {
  issue: number;
  removed: string[];
  kept: string[];
  dryRun?: boolean;
}

export function parseResetIssues(raw: string[]): number[] {
  const out: number[] = [];
  for (const v of raw) {
    if (!/^\d+$/.test(v) || Number(v) <= 0) throw new Error(`factory reset: "${v}" is not an issue number`);
    const n = Number(v);
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** Why removing this worktree/branch would lose work, or null when it is safe (same probes as `worktree gc`). */
async function unsafeReason(deps: ResetDeps, path: string | null, rev: string | null): Promise<string | null> {
  if (path !== null && !(await isWorktreeClean(deps.runCommand, path))) return 'uncommitted changes';
  if (rev === null) return 'could not verify it is pushed';
  const n = await countUnpushedCommits(deps.runCommand, deps.repoRoot, rev);
  if (n === null) return 'could not verify it is pushed';
  return n > 0 ? `${n} unpushed commit(s)` : null;
}

export async function resetIssue(issue: number, deps: ResetDeps): Promise<ResetResult> {
  const { paths, branchPrefix } = deps;
  const dry = deps.dryRun === true;
  const removed: string[] = [];
  const kept: string[] = [];
  const protectedBranches = new Map<string, string>();
  const removedWorktrees = new Set<string>();

  // 1. Worktrees
  try {
    const entries = parseWorktreeList(await deps.git('git worktree list --porcelain'));
    for (const entry of entries) {
      if (entry.branch === null || factoryBranchIssue(entry.branch, branchPrefix) !== issue) continue;
      const isMain = resolve(entry.path) === resolve(deps.repoRoot);
      const hasCwd = deps.cwd === entry.path || deps.cwd.startsWith(entry.path + sep);
      if (isMain || hasCwd) {
        kept.push(`worktree ${entry.path} (current checkout)`);
        protectedBranches.set(entry.branch, entry.path);
        continue;
      }
      if (!deps.force) {
        const why = await unsafeReason(deps, entry.path, entry.head ?? entry.branch);
        if (why !== null) {
          kept.push(`worktree ${entry.path} (${why}; pass --force to remove)`);
          protectedBranches.set(entry.branch, entry.path);
          continue;
        }
      }
      try {
        if (!dry) await deps.removeWorktree(entry.path);
        removed.push(`worktree ${entry.path}`);
        removedWorktrees.add(entry.path);
      } catch (err) {
        kept.push(`worktree ${entry.path} (${errText(err)})`);
        protectedBranches.set(entry.branch, entry.path);
      }
    }
  } catch (err) {
    kept.push(`worktrees (git worktree list failed: ${errText(err)})`);
  }

  // 2. Local branches
  try {
    const refs = await deps.git("git for-each-ref --format='%(refname:short)' refs/heads/");
    const branches = refs
      .split('\n')
      .map((b) => b.trim())
      .filter((b) => b && factoryBranchIssue(b, branchPrefix) === issue);
    for (const b of branches) {
      const where = protectedBranches.get(b);
      if (where !== undefined) {
        kept.push(`branch ${b} (checked out in ${where})`);
        continue;
      }
      if (!deps.force) {
        const why = await unsafeReason(deps, null, b);
        if (why !== null) {
          kept.push(`branch ${b} (${why}; pass --force to remove)`);
          continue;
        }
      }
      try {
        if (!dry) await deps.git(`git branch -D ${shellQuote(b)}`);
        removed.push(`branch ${b}`);
      } catch (err) {
        kept.push(`branch ${b} (${errText(err)})`);
      }
    }
  } catch (err) {
    kept.push(`branches (${errText(err)})`);
  }

  // 3. Plan files
  try {
    let count = 0;
    for (const ext of ['md', 'design.json', 'design.md', 'adr.json']) {
      const file = join(paths.plans, `issue-${issue}.${ext}`);
      if (!existsSync(file)) continue;
      if (dry) removed.push(`plan file ${file}`);
      else rmSync(file, { force: true });
      count++;
    }
    if (!dry && count > 0) removed.push(`plan files (${count})`);
  } catch (err) {
    kept.push(`plan files (${errText(err)})`);
  }

  // 4. Phase file
  try {
    const file = phaseSnapshotFile(paths.runs, issue);
    if (existsSync(file)) {
      if (!dry) rmSync(file, { force: true });
      removed.push(dry ? `phase file ${file}` : 'phase file');
    }
  } catch (err) {
    kept.push(`phase file (${errText(err)})`);
  }

  // 5. Rework history
  try {
    const history = new ReworkHistory(paths.reworkHistory);
    if (dry) {
      if ((await history.priorSignature(issue)) !== undefined) removed.push(`rework history entry #${issue}`);
    } else if (await history.clear(issue)) removed.push('rework history');
  } catch (err) {
    kept.push(`rework history (${errText(err)})`);
  }

  // 6. Logs
  try {
    const dir = join(paths.logs, `issue-${issue}`);
    if (existsSync(dir)) {
      if (!dry) rmSync(dir, { recursive: true, force: true });
      removed.push(dry ? `logs ${dir}` : 'logs');
    }
  } catch (err) {
    kept.push(`logs (${errText(err)})`);
  }

  // 7. Lane-file claim
  try {
    const guard = new LaneFileGuard(paths.laneFiles);
    if (dry) {
      for (const c of await guard.claimsForIssue(issue)) removed.push(`lane-file claim ${c.repo}#${c.issue}`);
    } else if (await guard.releaseIssue(issue)) removed.push('lane-file claim');
  } catch (err) {
    kept.push(`lane-file claim (${errText(err)})`);
  }

  // 8. Port leases — never for a kept worktree
  try {
    const keptPaths = new Set(protectedBranches.values());
    for (const lease of deps.readLeases()) {
      if (keptPaths.has(lease.worktreeId)) continue;
      if (!removedWorktrees.has(lease.worktreeId) && factoryBranchIssue(lease.branch, branchPrefix) !== issue) continue;
      try {
        if (!dry) await deps.releaseLease(lease.worktreeId);
        removed.push(`port lease ${lease.port}`);
      } catch (err) {
        kept.push(`port lease ${lease.port} (${errText(err)})`);
      }
    }
  } catch (err) {
    kept.push(`port leases (${errText(err)})`);
  }

  return { issue, removed, kept, ...(dry ? { dryRun: true } : {}) };
}

export function formatResetLine(r: ResetResult): string {
  if (r.dryRun) {
    if (r.removed.length === 0 && r.kept.length === 0) return `#${r.issue} (dry run): nothing to reset`;
    return `#${r.issue} (dry run): would remove ${r.removed.join(', ') || 'nothing'}; would keep ${r.kept.join(', ') || 'nothing'}`;
  }
  if (r.removed.length === 0 && r.kept.length === 0) return `#${r.issue}: nothing to reset`;
  return `#${r.issue}: removed ${r.removed.join(', ') || 'nothing'}; kept ${r.kept.join(', ') || 'nothing'}`;
}

export async function runReset(issues: number[], deps: ResetDeps): Promise<string[]> {
  const lines: string[] = [];
  for (const issue of issues) lines.push(formatResetLine(await resetIssue(issue, deps)));
  return lines;
}
