// packages/cli/src/cli/host-claim-guards.ts — host load and disk guards for runLane's remote claims (#3048, #2284)

import type { FactoryConfig } from '@on-par/factory-core';
import { createDiskGuard, evaluateLoadGuard, readHostLoad, resolveHostLoadGuard } from '@on-par/factory-core/internal';

import type { RunLaneDeps } from './run-lane-deps.js';

/** The `loadGuard` and `diskGuard` lane deps; local-queue lanes get neither. */
export function hostClaimGuards(
  config: FactoryConfig,
  where: { repoRoot: string; ghRepo: string; stateRoot: string },
  localQueue: boolean,
): Pick<RunLaneDeps, 'loadGuard' | 'diskGuard'> {
  if (localQueue) return {};
  const loadPolicy = resolveHostLoadGuard(config);
  const disk = createDiskGuard(config, where);
  return { loadGuard: () => evaluateLoadGuard(loadPolicy, readHostLoad()), diskGuard: () => disk.check() };
}
