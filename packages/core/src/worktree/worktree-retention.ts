// src/worktree/worktree-retention.ts — repository-wide retention budget for finished lane worktrees (#3970).
// Eviction removes only the worktree directory of a tree whose content is fully recoverable from
// origin; the local branch is never deleted, so land can recreate the tree from origin/<branch>.

import { rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { defaultFactoryConfig } from '@on-par/factory-config';

import { getFactoryPaths, type FactoryConfig } from '../config/index.js';
import { shellEscape } from '../utils/index.js';
import { removeMicroVm } from '../utils/microvm.js';
import {
  createEvidenceContext,
  defaultRunCommand,
  gatherWorktreeEvidence,
  hasUntrackedFiles,
  laneIssueNumber,
  resolveMainTip,
  type WorktreeEvidence,
} from './worktree-gc-evidence.js';
import { isQuarantinedPath, listFactoryWorktrees, parseWorktreeList, quarantineRoot } from './worktree-gc.js';
import { defaultIssueWarnDedup, type SweepDeps } from './worktree-gc-types.js';
import { readWorktreeKeeps, type WorktreeKeep } from './worktree-keeps.js';

/** The branch suffix of a conflict-rebuild lane (the same marker cli's `isRebuildBranch` checks). */
const REBUILD_SUFFIX = '-rebuild';

export interface RetentionPolicy {
  /** 0 = count budget off. */
  maxRetained: number;
}

export type RetentionProtection = 'active-claim' | 'conflict-rebuild' | 'keep-record' | 'unrecoverable';

export interface RetentionCandidate {
  path: string;
  branch: string | null;
  issue: number | null;
  ageDays: number;
  kind: 'pr-backed' | 'finished';
  protectedBy: RetentionProtection | null;
  /** Human reason when protectedBy is not null. */
  why: string | null;
}

export interface RetentionSelection {
  retained: number;
  target: number;
  evict: RetentionCandidate[];
  protected: RetentionCandidate[];
}

export interface RetentionReport extends RetentionSelection {
  evicted: RetentionCandidate[];
  failed: Array<{ path: string; error: string }>;
}

export function resolveRetentionPolicy(config: Pick<FactoryConfig, 'worktree'>): RetentionPolicy {
  return { maxRetained: config.worktree.retainMax ?? defaultFactoryConfig.worktree.retainMax };
}

function isRebuild(e: WorktreeEvidence, rebuildIssues: ReadonlySet<number>): boolean {
  return (e.branch?.endsWith(REBUILD_SUFFIX) ?? false) || (e.issue !== null && rebuildIssues.has(e.issue));
}

/** Why the tree's content might not be fully on origin; null when it is recoverable. Any null or
 *  failed probe protects (fail closed). */
function unrecoverableReason(e: WorktreeEvidence): string | null {
  const g = e.git;
  if (e.branch === null) return 'detached HEAD';
  if (!g.clean) return 'uncommitted changes';
  if (g.untracked === true) return 'untracked files';
  if (g.untracked !== false) return 'untracked probe failed';
  if (e.head === null) return 'HEAD could not be resolved';
  if (g.unpushedCount === null) return 'could not verify pushed';
  if (g.unpushedCount > 0) return `${g.unpushedCount} unpushed commit(s)`;
  if (g.remoteBranch === 'present') return null;
  if (g.remoteBranch === 'absent') return 'origin branch absent';
  if (g.remoteBranch === 'timed-out') return 'remote check timed out';
  return 'remote check failed';
}

export function retentionCandidateOf(
  e: WorktreeEvidence,
  opts: { rebuildIssues: ReadonlySet<number> },
): RetentionCandidate {
  const base = {
    path: e.path,
    branch: e.branch,
    issue: e.issue,
    ageDays: e.ageDays,
    kind: e.prState === 'open' ? ('pr-backed' as const) : ('finished' as const),
  };
  const protect = (protectedBy: RetentionProtection, why: string): RetentionCandidate => ({
    ...base,
    protectedBy,
    why,
  });
  const rebuild = isRebuild(e, opts.rebuildIssues);
  if (e.protected) {
    return rebuild
      ? protect('conflict-rebuild', 'conflict rebuild in flight')
      : protect('active-claim', 'issue in flight in this run');
  }
  if (e.disposition === 'keep-claimed') return protect('active-claim', 'live claim label');
  if (rebuild) return protect('conflict-rebuild', 'conflict rebuild tree');
  if (e.keep) return protect('keep-record', e.keep.reason);
  const why = unrecoverableReason(e);
  if (why !== null) return protect('unrecoverable', why);
  return { ...base, protectedBy: null, why: null };
}

export function selectRetentionEvictions(
  candidates: readonly RetentionCandidate[],
  policy: RetentionPolicy,
  opts: { pressure?: boolean } = {},
): RetentionSelection {
  const pressure = opts.pressure === true;
  const retained = candidates.length;
  const target = pressure ? 0 : policy.maxRetained;
  const protectedList = candidates.filter((c) => c.protectedBy !== null);
  if (!pressure && policy.maxRetained === 0) return { retained, target, evict: [], protected: protectedList };
  const eligible = candidates
    .filter((c) => c.protectedBy === null)
    .sort((a, b) => b.ageDays - a.ageDays || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    retained,
    target,
    evict: eligible.slice(0, Math.max(0, retained - target)),
    protected: protectedList,
  };
}

export async function reclaimRetainedWorktrees(
  opts: {
    repoRoot: string;
    repo?: string;
    branchPrefix?: string;
    policy: RetentionPolicy;
    pressure?: boolean;
    protectedIssues?: ReadonlySet<number>;
    keepsFile?: string;
  },
  deps: SweepDeps = {},
): Promise<RetentionReport> {
  const {
    runCommand = defaultRunCommand,
    now = () => Date.now(),
    log = () => {},
    octokit,
    sandbox,
    issueWarnDedup = defaultIssueWarnDedup,
  } = deps;
  const { repoRoot, policy } = opts;
  const pressure = opts.pressure === true;

  const { stdout } = await runCommand('git worktree list --porcelain', { cwd: repoRoot });
  const listed = listFactoryWorktrees(parseWorktreeList(stdout), repoRoot, opts.branchPrefix);
  const quarantineDir = quarantineRoot(repoRoot);
  const entries = listed.candidates.filter((c) => !isQuarantinedPath(quarantineDir, c.path));
  const empty = { evicted: [], failed: [] };

  const target = pressure ? 0 : policy.maxRetained;
  if (entries.length <= target && !pressure) {
    return { retained: entries.length, target, evict: [], protected: [], ...empty };
  }
  if (!pressure && policy.maxRetained === 0) {
    return { retained: entries.length, target, evict: [], protected: [], ...empty };
  }

  const rebuildIssues = new Set<number>();
  for (const entry of entries) {
    if (!entry.branch?.endsWith(REBUILD_SUFFIX)) continue;
    const issue = laneIssueNumber(entry, listed.lanePattern);
    if (issue !== null) rebuildIssues.add(issue);
  }

  const mainTip = entries.length > 0 ? await resolveMainTip(runCommand, repoRoot) : null;
  const keepsFile = opts.keepsFile ?? getFactoryPaths(repoRoot).worktreeKeeps;
  const keeps = new Map<number, WorktreeKeep>(readWorktreeKeeps(keepsFile, log).map((k) => [k.issue, k]));
  const ctx = createEvidenceContext(
    {
      repoRoot,
      repo: opts.repo,
      dryRun: false,
      lanePattern: listed.lanePattern,
      protectedIssues: opts.protectedIssues,
      keeps,
      mainTip,
    },
    { runCommand, now, log, octokit, issueWarnDedup },
  );

  const candidates: RetentionCandidate[] = [];
  for (const entry of entries) {
    let evidence = await gatherWorktreeEvidence(ctx, entry);
    if (!evidence.protected && evidence.git.untracked === false) {
      evidence = {
        ...evidence,
        git: { ...evidence.git, untracked: await hasUntrackedFiles(runCommand, entry.path) },
      };
    }
    candidates.push(retentionCandidateOf(evidence, { rebuildIssues }));
  }

  const selection = selectRetentionEvictions(candidates, policy, { pressure });
  for (const c of selection.protected) {
    log('worktree-gc', `retention: kept ${c.path} (#${c.issue ?? '?'}) — ${c.protectedBy}: ${c.why}`);
  }

  const evicted: RetentionCandidate[] = [];
  const failed: Array<{ path: string; error: string }> = [];
  for (const c of selection.evict) {
    if (sandbox) await removeMicroVm({ ...sandbox, worktreePath: c.path, log });
    try {
      await runCommand(`git worktree remove --force ${shellEscape(c.path)}`, { cwd: repoRoot });
    } catch (err: any) {
      log('warn', `retention: git worktree remove failed for ${c.path}: ${err?.message ?? String(err)}`);
      try {
        rmSync(resolve(c.path), { recursive: true, force: true });
      } catch (rmErr: any) {
        const error = rmErr?.message ?? String(rmErr);
        log('warn', `retention: rmSync fallback failed for ${c.path}: ${error}`);
        failed.push({ path: c.path, error });
        continue;
      }
    }
    evicted.push(c);
    log(
      'worktree-gc',
      `retention: evicted ${c.path} (#${c.issue ?? '?'}) — ${c.kind}, recoverable from origin/${c.branch}`,
    );
  }

  await runCommand('git worktree prune', { cwd: repoRoot }).catch((err: any) =>
    log('warn', `retention: git worktree prune failed in ${repoRoot}: ${err?.message ?? String(err)}`),
  );

  return { ...selection, evicted, failed };
}
