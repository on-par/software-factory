// packages/cli/src/cli/worktree-retention.ts — the disk gates' retained-worktree reclaimer (#3970)

import type { EventKind, FactoryConfig, getFactoryPaths } from '@on-par/factory-core';
import type { RetentionReport } from '@on-par/factory-core/internal';
import {
  reclaimRetainedWorktrees,
  resolveBranchPrefix,
  resolveRetentionPolicy,
  withFileLock,
  withGitLock,
} from '@on-par/factory-core/internal';

import { gcWorktreeSandbox } from './worktree-reap.js';

type ReclaimDeps = NonNullable<Parameters<typeof reclaimRetainedWorktrees>[1]>;
type Paths = Pick<ReturnType<typeof getFactoryPaths>, 'mergeLock' | 'gitLock'>;

/** The lock nesting every worktree sweep holds: git lock, then the merge lock with a zero timeout (so a
 *  land is never raced; a busy lock throws a `reason: 'timeout'` error), then the git file lock. */
export function underSweepLocks<T>(repoRoot: string, paths: Paths, body: () => Promise<T>): Promise<T> {
  return withGitLock(repoRoot, () =>
    withFileLock(paths.mergeLock, () => withFileLock(paths.gitLock, body), { timeoutMs: 0 }),
  );
}

export interface RetentionWhere {
  repoRoot: string;
  ghRepo: string;
  paths: Paths;
  branchPrefix?: string;
  /** Issues in flight in this run, read at reclaim time: their trees are never evicted. */
  protectedIssues: () => ReadonlySet<number>;
  log: (kind: EventKind, message: string) => void;
}

export interface RetentionReclaimerDeps {
  octokit?: () => ReclaimDeps['octokit'];
  reclaim?: typeof reclaimRetainedWorktrees;
}

/** Builds the reclaimer a disk gate runs before it waits. It takes the same git + merge + git-file lock
 *  nesting as `sweepBetweenLaneIssues`, with a zero-timeout merge lock so a land is never raced. Resolves
 *  `'skipped'` on a busy merge lock or any error; never throws. */
export function retentionReclaimer(
  config: Pick<FactoryConfig, 'worktree' | 'sandbox' | 'run'>,
  where: RetentionWhere,
  deps: RetentionReclaimerDeps = {},
): (pressure: boolean) => Promise<RetentionReport | 'skipped'> {
  const { reclaim = reclaimRetainedWorktrees, octokit } = deps;
  return async (pressure) => {
    try {
      return await underSweepLocks(where.repoRoot, where.paths, () =>
        reclaim(
          {
            repoRoot: where.repoRoot,
            repo: where.ghRepo,
            branchPrefix: where.branchPrefix ?? resolveBranchPrefix(config),
            policy: resolveRetentionPolicy(config),
            pressure,
            protectedIssues: where.protectedIssues(),
          },
          { log: where.log, octokit: octokit?.(), sandbox: gcWorktreeSandbox(config.sandbox, where.repoRoot) },
        ),
      );
    } catch (err: any) {
      if (err?.reason !== 'timeout') {
        where.log('warn', `worktree retention reclaim failed: ${err?.message ?? String(err)}`);
      }
      return 'skipped';
    }
  };
}

/** The mid-run count-budget pass (#3970). Resolves the one-line summary when it evicted anything, else null.
 *  A failure is logged as a warn and never throws, so it cannot discard the sweep's result. */
export async function retentionBudgetPass(
  reclaim: typeof reclaimRetainedWorktrees | undefined,
  config: Pick<FactoryConfig, 'worktree'>,
  opts: Omit<Parameters<typeof reclaimRetainedWorktrees>[0], 'policy'>,
  deps: ReclaimDeps,
): Promise<string | null> {
  const policy = resolveRetentionPolicy(config);
  try {
    const report = await (reclaim ?? reclaimRetainedWorktrees)({ ...opts, policy }, deps);
    return report.evicted.length === 0
      ? null
      : `retention: evicted ${report.evicted.length} of ${report.retained} retained worktree(s) (budget ${policy.maxRetained})`;
  } catch (err: any) {
    deps.log?.('warn', `mid-run retention reclaim failed: ${err?.message ?? String(err)}`);
    return null;
  }
}
