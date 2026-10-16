// packages/cli/src/cli/host-slot.ts — Wires RunPorts.hostBuildSlot (#3043) from host.maxBuilds,
// composed with an optional per-run lane gate (#3049).

import type { EventKind, FactoryConfig, RunPorts } from '@on-par/factory-core';
import type { RunSlotGate } from '@on-par/factory-core/internal';
import { hostBuildSlotsDir, resolveHostMaxBuilds, withRunAndHostBuildSlot } from '@on-par/factory-core/internal';

/** Gates each BUILD and CHECK call on one of `host.maxBuilds` slots shared by every runner on this host, and on `runSlots` when supplied. */
export function hostBuildSlotPort(
  config: FactoryConfig,
  repo: string,
  issue: number,
  log: (kind: EventKind, message: string) => void,
  runSlots?: RunSlotGate,
): NonNullable<RunPorts['hostBuildSlot']> {
  const maxBuilds = resolveHostMaxBuilds(config);
  return (phase, fn) =>
    withRunAndHostBuildSlot(
      { dir: hostBuildSlotsDir(), maxBuilds, repo, issue, phase, log: (m) => log('environment_lease', m), runSlots },
      fn,
    );
}
