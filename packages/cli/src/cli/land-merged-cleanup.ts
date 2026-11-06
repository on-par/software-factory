import type { EventKind, FactoryConfig } from '@on-par/factory-core';
import type { getFactoryPaths } from '@on-par/factory-core';
import { LaneFileGuard, resolveSandboxPolicy, workKeyFromIssue } from '@on-par/factory-core';
import { releaseLaneClaim, resolveEffectiveConfig, worktreeSandboxFor } from '@on-par/factory-core/internal';

import { landLockFor } from './land-slot.js';
import { landRuntime } from './land-runtime.js';

export async function releaseLandedClaim(
  paths: ReturnType<typeof getFactoryPaths>,
  ghRepo: string,
  issue: number,
  log: (type: EventKind, msg: string) => void,
): Promise<void> {
  if (!paths.laneFiles) return;
  await releaseLaneClaim(new LaneFileGuard(paths.laneFiles), ghRepo, workKeyFromIssue(issue), log);
}

/** #3966: a PR that merged while its lane was in waitForMerge gets the same cleanup as a land()
 *  success: release the claim, then remove the worktree. Best-effort; never throws. */
export async function cleanupMergedLane(
  issue: number,
  repoRoot: string,
  ghRepo: string,
  paths: ReturnType<typeof getFactoryPaths>,
  opts: {
    factoryConfig: FactoryConfig;
    issueless?: boolean;
    holdsLandingSlot?: boolean;
    log: (type: EventKind, msg: string) => void;
  },
): Promise<void> {
  const { factoryConfig, issueless, holdsLandingSlot, log } = opts;
  const { configLoaders, gitOps, errorDetail, worktreePathFor } = landRuntime();
  try {
    if (!issueless) await releaseLandedClaim(paths, ghRepo, issue, log);
    const prefix = resolveEffectiveConfig(
      configLoaders.loadRepoConfig(repoRoot),
      process.env,
      factoryConfig,
    ).branchPrefix;
    const worktree = worktreePathFor(repoRoot, ghRepo, issue, prefix);
    const policy = resolveSandboxPolicy(factoryConfig.sandbox, { worktree, repoRoot });
    const sandbox = worktreeSandboxFor(policy?.runtime, { allowHosts: policy?.allowHosts ?? [] });
    await landLockFor(
      repoRoot,
      paths,
      log,
      holdsLandingSlot === true,
    )(() => gitOps.cleanupWorktree(repoRoot, worktree, log, sandbox));
  } catch (err) {
    log('warn', `merged-lane cleanup failed for #${issue}: ${errorDetail(err)}`);
  }
}
