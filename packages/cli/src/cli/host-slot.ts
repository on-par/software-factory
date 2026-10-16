// packages/cli/src/cli/host-slot.ts — Wires RunPorts.hostBuildSlot (#3043) from host.maxBuilds.

import type { EventKind, FactoryConfig, RunPorts } from '@on-par/factory-core';
import { hostBuildSlotsDir, resolveHostMaxBuilds, withHostBuildSlot } from '@on-par/factory-core/internal';

/** Gates each BUILD and CHECK call on one of `host.maxBuilds` slots shared by every runner on this host. */
export function hostBuildSlotPort(
  config: FactoryConfig,
  repo: string,
  issue: number,
  log: (kind: EventKind, message: string) => void,
): NonNullable<RunPorts['hostBuildSlot']> {
  const maxBuilds = resolveHostMaxBuilds(config);
  return (phase, fn) =>
    withHostBuildSlot(
      { dir: hostBuildSlotsDir(), maxBuilds, repo, issue, phase, log: (m) => log('environment_lease', m) },
      fn,
    );
}
