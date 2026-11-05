// packages/cli/src/cli/status-land-deferred.ts — the `factory status` Land deferred section and its JSON rows (#3957)

import type { FactoryConfig, getFactoryPaths } from '@on-par/factory-core';
import {
  landDeferredFile,
  readLandDeferred,
  resolveMaxLandDeferrals,
  type LandDeferredRecord,
} from '@on-par/factory-core/internal';

export interface LandDeferredStatus {
  records: LandDeferredRecord[];
  maxDeferrals: number;
}

/** Reads the land-deferred queue and the cap. An unreadable config falls back to the default cap; this never throws. */
export async function readLandDeferredStatus(
  paths: ReturnType<typeof getFactoryPaths>,
  loadConfig: () => FactoryConfig,
): Promise<LandDeferredStatus> {
  let maxDeferrals = resolveMaxLandDeferrals({});
  try {
    maxDeferrals = resolveMaxLandDeferrals(loadConfig());
  } catch {
    // config unreadable: report the default cap
  }
  return { records: await readLandDeferred(landDeferredFile(paths)), maxDeferrals };
}

/** The lines under `== Land deferred ==`, oldest deferral first. */
export function formatLandDeferredSection(status: LandDeferredStatus): string[] {
  if (status.records.length === 0) return ['  (none)'];
  return [...status.records]
    .sort((a, b) => a.firstDeferredAt - b.firstDeferredAt || a.issue - b.issue)
    .map(
      (r) =>
        `  #${r.issue} PR #${r.prNumber} deferred ${r.deferrals}/${status.maxDeferrals}, next retry ${new Date(r.nextRetryAt).toISOString()}`,
    );
}
