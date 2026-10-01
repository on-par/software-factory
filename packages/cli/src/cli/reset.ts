// packages/cli/src/cli/reset.ts — `factory reset <issue...>`: remove an issue's local factory state (#1787).

import { existsSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

import { LaneFileGuard, phaseSnapshotFile, type PortLease, ReworkHistory } from '@on-par/factory-core';
import { factoryBranchIssue, parseWorktreeList } from '@on-par/factory-core/internal';

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
}

export interface ResetResult {
  issue: number;
  removed: string[];
  kept: string[];
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

export async function resetIssue(issue: number, deps: ResetDeps): Promise<ResetResult> {
  const { paths, branchPrefix } = deps;
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
      try {
        await deps.removeWorktree(entry.path);
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
      try {
        await deps.git(`git branch -D ${shellQuote(b)}`);
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
      rmSync(file, { force: true });
      count++;
    }
    if (count > 0) removed.push(`plan files (${count})`);
  } catch (err) {
    kept.push(`plan files (${errText(err)})`);
  }

  // 4. Phase file
  try {
    const file = phaseSnapshotFile(paths.runs, issue);
    if (existsSync(file)) {
      rmSync(file, { force: true });
      removed.push('phase file');
    }
  } catch (err) {
    kept.push(`phase file (${errText(err)})`);
  }

  // 5. Rework history
  try {
    if (await new ReworkHistory(paths.reworkHistory).clear(issue)) removed.push('rework history');
  } catch (err) {
    kept.push(`rework history (${errText(err)})`);
  }

  // 6. Logs
  try {
    const dir = join(paths.logs, `issue-${issue}`);
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
      removed.push('logs');
    }
  } catch (err) {
    kept.push(`logs (${errText(err)})`);
  }

  // 7. Lane-file claim
  try {
    if (await new LaneFileGuard(paths.laneFiles).releaseIssue(issue)) removed.push('lane-file claim');
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
        await deps.releaseLease(lease.worktreeId);
        removed.push(`port lease ${lease.port}`);
      } catch (err) {
        kept.push(`port lease ${lease.port} (${errText(err)})`);
      }
    }
  } catch (err) {
    kept.push(`port leases (${errText(err)})`);
  }

  return { issue, removed, kept };
}

export function formatResetLine(r: ResetResult): string {
  if (r.removed.length === 0 && r.kept.length === 0) return `#${r.issue}: nothing to reset`;
  return `#${r.issue}: removed ${r.removed.join(', ') || 'nothing'}; kept ${r.kept.join(', ') || 'nothing'}`;
}

export async function runReset(issues: number[], deps: ResetDeps): Promise<string[]> {
  const lines: string[] = [];
  for (const issue of issues) lines.push(formatResetLine(await resetIssue(issue, deps)));
  return lines;
}
