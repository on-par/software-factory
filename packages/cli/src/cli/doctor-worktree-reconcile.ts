// packages/cli/src/cli/doctor-worktree-reconcile.ts — `doctor --reconcile` worktree sweep (#998)

import type { Octokit } from '@octokit/rest';
import type { EventKind, FactoryConfig, getFactoryPaths } from '@on-par/factory-core';
import { logEvent, resolveBranchPrefix, withFileLock, withGitLock } from '@on-par/factory-core/internal';

import { formatWorktreeReconcileReport } from './doctor-health.js';
import type { DoctorRuntime } from './doctor.js';

/** Never throws: a failed sweep prints its own failure line. */
export async function reconcileWorktrees(
  rt: Pick<DoctorRuntime, 'gcWorktreeSandbox'> & { internalOps: Pick<DoctorRuntime['internalOps'], 'sweepWorktrees'> },
  repoRoot: string,
  paths: ReturnType<typeof getFactoryPaths>,
  factoryConfig: FactoryConfig,
  ghRepo: string | undefined,
  octokit: Octokit | undefined,
): Promise<void> {
  try {
    const gcLog = (type: EventKind, msg: string) => logEvent(paths.events, type, '-', msg);
    const gcSandbox = rt.gcWorktreeSandbox(factoryConfig.sandbox, repoRoot);
    const report = await withGitLock(repoRoot, () =>
      withFileLock(paths.gitLock, () =>
        rt.internalOps.sweepWorktrees(
          {
            repoRoot,
            ttlDays: factoryConfig.worktree.gcTtlDays,
            repo: ghRepo,
            branchPrefix: resolveBranchPrefix(),
          },
          { log: gcLog, octokit, sandbox: gcSandbox },
        ),
      ),
    );
    console.log(formatWorktreeReconcileReport(report.removed));
  } catch (err: any) {
    console.log(`reconcile: worktree sweep failed: ${err?.message ?? String(err)}`);
  }
}
