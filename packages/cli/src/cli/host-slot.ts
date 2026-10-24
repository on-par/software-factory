// packages/cli/src/cli/host-slot.ts — Wires RunPorts.hostBuildSlot (#3043) from host.maxBuilds,
// composed with an optional per-run lane gate (#3049).

import type { EventKind, FactoryConfig, RunPorts } from '@on-par/factory-core';
import type { DiskGuard, RunSlotGate } from '@on-par/factory-core/internal';
import { formatDiskHold, hostBuildSlotsDir, resolveHostMaxBuilds, withRunAndHostBuildSlot } from '@on-par/factory-core/internal';

/** Gates each BUILD and CHECK call on one of `host.maxBuilds` slots shared by every runner on this host, and on `runSlots` when supplied. */
export function hostBuildSlotPort(
  config: FactoryConfig,
  repo: string,
  issue: number,
  log: (kind: EventKind, message: string) => void,
  runSlots?: RunSlotGate,
  disk?: { guard: DiskGuard; sleep?: (ms: number) => Promise<void>; now?: () => Date },
): NonNullable<RunPorts['hostBuildSlot']> {
  const maxBuilds = resolveHostMaxBuilds(config);
  const sleep = disk?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = disk?.now ?? (() => new Date());
  /** Waits (before any slot is taken) while the disk guard holds (#2284); a guard error counts as claim. */
  const waitForDisk = async (guard: DiskGuard, phase: string): Promise<void> => {
    let first = true;
    for (;;) {
      let d: ReturnType<DiskGuard['check']>;
      try {
        d = guard.check();
      } catch {
        return;
      }
      if (d.kind !== 'hold') return;
      const retryAt = new Date(now().getTime() + d.retryMs);
      log(first ? 'disk_low' : 'warn', formatDiskHold(`#${issue} ${phase} waiting:`, d, retryAt));
      first = false;
      await sleep(d.retryMs);
    }
  };
  return async (phase, fn) => {
    if (disk) await waitForDisk(disk.guard, phase);
    return withRunAndHostBuildSlot(
      { dir: hostBuildSlotsDir(), maxBuilds, repo, issue, phase, log: (m) => log('environment_lease', m), runSlots },
      fn,
    );
  };
}
