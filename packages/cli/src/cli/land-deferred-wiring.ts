// packages/cli/src/cli/land-deferred-wiring.ts — production RunLaneDeps for the land-deferred record and retry (#3957)

import type { FactoryConfig, getFactoryPaths } from '@on-par/factory-core';
import {
  clearLandDeferred,
  decideLandDeferral,
  landDeferredFile,
  readLandDeferred,
  resolveMaxLandDeferrals,
  upsertLandDeferred,
} from '@on-par/factory-core/internal';

import { retryDueLandDeferred } from './land-deferred-retry.js';
import { waitForMerge } from './land.js';
import type { LandDeferredError } from './land-pr.js';
import { withLandingSlot } from './land-slot.js';
import type { RunLaneDeps } from './run-lane-deps.js';

/** Binds the land-deferred store, cap, landing slot and land-only merge into the two RunLaneDeps that use them. */
export function landDeferredLaneDeps(
  ghRepo: string,
  repoRoot: string,
  paths: ReturnType<typeof getFactoryPaths>,
  config: FactoryConfig,
): Pick<RunLaneDeps, 'recordLandDeferred' | 'retryLandDeferred'> {
  const file = landDeferredFile(paths);
  const maxDeferrals = resolveMaxLandDeferrals(config);
  return {
    recordLandDeferred: async (err: LandDeferredError, issue, branch) => {
      const prev = (await readLandDeferred(file)).find((r) => r.issue === issue);
      const decision = decideLandDeferral(
        prev,
        { issue, prNumber: err.prNumber, branch, message: err.message },
        { now: Date.now(), maxDeferrals },
      );
      if (decision.kind === 'defer') await upsertLandDeferred(file, decision.record);
      else await clearLandDeferred(file, issue); // the lane parks it now; nothing left to retry
      return { ...decision, maxDeferrals };
    },
    retryLandDeferred: (ops) =>
      retryDueLandDeferred({
        ...ops,
        file,
        now: Date.now,
        maxDeferrals,
        withSlot: (fn) => withLandingSlot(paths, fn),
        land: (rec) =>
          waitForMerge(rec.issue, rec.branch, repoRoot, ghRepo, paths, {
            landBranch: rec.branch,
            syncMain: true,
            holdsLandingSlot: true,
            holdWhenGated: true,
          }),
      }),
  };
}
