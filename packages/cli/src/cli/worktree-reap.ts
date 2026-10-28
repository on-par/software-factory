// packages/cli/src/cli/worktree-reap.ts — eager lane-worktree reaps (#1007, #3008), moved out of index.ts

import type { EventKind, FactoryConfig, getFactoryPaths } from '@on-par/factory-core';
import { resolveSandboxPolicy } from '@on-par/factory-core';
import {
  type LaneWorktreeReapResult,
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
): Promise<{ worktreePath: string | undefined; result: R | undefined }> {
  let worktreePath: string | undefined;
  try {
    const factoryConfig = rt.configLoaders.loadFactoryConfigForRepo(paths.config);
    const branchPrefix =
      prefixOverride ??
      resolveEffectiveConfig(rt.configLoaders.loadRepoConfig(repoRoot), process.env, factoryConfig).branchPrefix;
    const resolved = rt.worktreePathFor(repoRoot, ghRepo, issue, branchPrefix);
    worktreePath = resolved;
    const log = (type: EventKind, msg: string) => logEvent(paths.events, type, issue, msg);
    const sandbox = gcWorktreeSandbox(factoryConfig.sandbox, repoRoot);
    const result = await withGitLock(repoRoot, () =>
      withFileLock(paths.gitLock, () =>
        reap(resolved, { issue, branchPrefix, log, sandbox, keepsFile: paths.worktreeKeeps }),
      ),
    );
    return { worktreePath, result };
  } catch (err: any) {
    logEvent(paths.events, 'warn', issue, `${failure}: ${err?.message ?? String(err)}`);
    return { worktreePath, result: undefined };
  }
}

/** Eagerly reaps a parked lane's own worktree inside `factory run` (#1007). All the safety
 *  gates, the keep record included, live in reapLaneWorktree. A reap failure is logged as a warn and never surfaces —
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

/** The one run-output line for a PR-less ship's reap: where the worktree is and why it was kept
 *  or removed (#3009). `undefined` means the reap threw, so the state is unknown. */
export function formatShipReapLine(worktreePath: string, result: LaneWorktreeReapResult | undefined): string | null {
  const unverified = `📌 Kept worktree ${worktreePath} — its state could not be verified, so nothing was removed`;
  if (result === undefined) return unverified;
  const withBranch = result.branch ? ` and branch ${result.branch}` : '';
  switch (result.outcome) {
    case 'removed':
      return `🧹 Removed worktree ${worktreePath}${result.branchDeleted ? ` and branch ${result.branch}` : ''} — no PR was opened and nothing was committed`;
    case 'kept-dirty':
      return `📌 Kept worktree ${worktreePath}${withBranch} — it has uncommitted changes`;
    case 'kept-untracked':
      return `📌 Kept worktree ${worktreePath}${withBranch} — it has untracked files`;
    case 'kept-record':
      return `📌 Kept worktree ${worktreePath}${withBranch} — it has a keep record`;
    case 'kept-committed':
      return `📌 Kept worktree ${worktreePath}${withBranch} — it has commits beyond the base`;
    case 'kept-branch-mismatch':
      return `📌 Kept worktree ${worktreePath} — it is on '${result.branch}', not this issue's lane branch`;
    case 'kept-unverified':
      return unverified;
    case 'absent':
      return null;
  }
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
  // No path means the config load failed, so ship never resolved (or created) a worktree here;
  // the failure is already logged as a warn event by reapUnderLock.
  if (done.worktreePath === undefined) return;
  const line = formatShipReapLine(done.worktreePath, done.result);
  if (line !== null) console.log(line);
}
