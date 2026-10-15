// packages/cli/src/cli/worktree-reap.ts — eager lane-worktree reaps (#1007, #3008), moved out of index.ts

import type { EventKind, FactoryConfig, getFactoryPaths } from '@on-par/factory-core';
import { resolveSandboxPolicy } from '@on-par/factory-core';
import {
  type WorktreeSandbox,
  logEvent,
  resolveEffectiveConfig,
  type reapCleanShipWorktree,
  type reapLaneWorktree,
  withFileLock,
  withGitLock,
  worktreeSandboxFor,
} from '@on-par/factory-core/internal';

import type { CliDeps } from './index.js';

type Paths = ReturnType<typeof getFactoryPaths>;

/** What the reaps read from index.ts's per-invocation state, passed in so they stay cycle-free. */
export interface ReapRuntime {
  configLoaders: Required<Pick<CliDeps, 'loadFactoryConfigForRepo' | 'loadRepoConfig'>>;
  worktreePathFor: (repoRoot: string, ghRepo: string, issue: number, prefix?: string) => string;
}

/** The repo's current docker-sandbox descriptor for worktree-gc sweeps, or undefined for
 *  every other runtime/config state (including a fixture config with no `sandbox` key). */
export function gcWorktreeSandbox(
  sandboxCfg: FactoryConfig['sandbox'] | undefined,
  repoRoot: string,
): WorktreeSandbox | undefined {
  if (!sandboxCfg) return undefined;
  const policy = resolveSandboxPolicy(sandboxCfg, { worktree: repoRoot, repoRoot });
  return worktreeSandboxFor(policy?.runtime);
}

/** Shared body of both reaps: resolves the lane's conventional worktree under the git+file
 *  lock pairing every worktree mutation site uses. Failures are logged as a warn and never surface. */
async function reapUnderLock<R>(
  rt: ReapRuntime,
  [issue, repoRoot, ghRepo, paths, prefixOverride]: [number, string, string, Paths, string | undefined],
  failure: string,
  reap: (worktreePath: string, opts: Parameters<typeof reapLaneWorktree>[2]) => Promise<R>,
): Promise<{ worktreePath: string; result: R } | undefined> {
  try {
    const factoryConfig = rt.configLoaders.loadFactoryConfigForRepo(paths.config);
    const branchPrefix =
      prefixOverride ?? resolveEffectiveConfig(rt.configLoaders.loadRepoConfig(repoRoot)).branchPrefix;
    const worktreePath = rt.worktreePathFor(repoRoot, ghRepo, issue, branchPrefix);
    const log = (type: EventKind, msg: string) => logEvent(paths.events, type, issue, msg);
    const sandbox = gcWorktreeSandbox(factoryConfig.sandbox, repoRoot);
    const result = await withGitLock(repoRoot, () =>
      withFileLock(paths.gitLock, () => reap(worktreePath, { issue, branchPrefix, log, sandbox })),
    );
    return { worktreePath, result };
  } catch (err: any) {
    logEvent(paths.events, 'warn', issue, `${failure}: ${err?.message ?? String(err)}`);
    return undefined;
  }
}

/** Eagerly reaps a parked lane's own worktree inside `factory run` (#1007). All the safety
 *  gates live in reapLaneWorktree. A reap failure is logged as a warn and never surfaces —
 *  parking must always succeed. */
export async function reapParkedLane(
  rt: ReapRuntime,
  reap: typeof reapLaneWorktree,
  args: Parameters<typeof reapUnderLock>[1],
): Promise<void> {
  await reapUnderLock(rt, args, 'parked-lane worktree reap failed', (worktreePath, opts) =>
    reap(args[1], worktreePath, opts),
  );
}

/** Removes a one-shot `factory ship`'s worktree and branch when it ended without a PR and left
 *  them clean with no commits (#3008). All safety gates live in reapCleanShipWorktree; a
 *  failure is logged as a warn and never changes the ship's exit. */
export async function reapPrlessShip(
  rt: ReapRuntime,
  reap: typeof reapCleanShipWorktree,
  args: Parameters<typeof reapUnderLock>[1],
): Promise<void> {
  const done = await reapUnderLock(rt, args, 'PR-less ship worktree cleanup failed', (worktreePath, opts) =>
    reap(args[1], worktreePath, opts),
  );
  if (done?.result.outcome === 'removed') {
    console.log(
      `🧹 Removed worktree ${done.worktreePath}${done.result.branchDeleted ? ` and branch ${done.result.branch}` : ''} — no PR was opened and nothing was committed`,
    );
  }
}
