// packages/cli/src/cli/host-slot.ts — Wires RunPorts.hostBuildSlot (#3043) from host.maxBuilds,
// composed with an optional per-run lane gate (#3049).

import type { EventKind, FactoryConfig, RunPorts } from '@on-par/factory-core';
import type { DiskGuard, RunSlotGate } from '@on-par/factory-core/internal';
import {
  createDiskGuard,
  formatDiskHold,
  hostBuildSlotsDir,
  readHostBuildSlots,
  resolveHostMaxBuilds,
  withRunAndHostBuildSlot,
} from '@on-par/factory-core/internal';

import { retentionReclaimer, type RetentionReclaimerDeps, type RetentionWhere } from './worktree-retention.js';

/** Gates each BUILD and CHECK call on one of `host.maxBuilds` slots shared by every runner on this host, and on `runSlots` when supplied. */
export function hostBuildSlotPort(
  config: FactoryConfig,
  repo: string,
  issue: number,
  log: (kind: EventKind, message: string) => void,
  runSlots?: RunSlotGate,
  disk?: {
    guard: DiskGuard;
    reclaim?: () => Promise<unknown>;
    sleep?: (ms: number) => Promise<void>;
    now?: () => Date;
  },
): NonNullable<RunPorts['hostBuildSlot']> {
  const maxBuilds = resolveHostMaxBuilds(config);
  const sleep = disk?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = disk?.now ?? (() => new Date());
  /** Waits (before any slot is taken) while the disk guard holds (#2284); a guard error counts as claim. */
  const waitForDisk = async (guard: DiskGuard, phase: string): Promise<void> => {
    let first = true;
    const check = (): ReturnType<DiskGuard['check']> => {
      try {
        return guard.check();
      } catch {
        return { kind: 'claim' };
      }
    };
    for (;;) {
      let d = check();
      if (d.kind !== 'hold') return;
      // Free evictable retained trees before waiting; a reclaim failure never blocks the wait (#3970).
      if (disk?.reclaim) {
        await disk.reclaim().catch(() => {});
        d = check();
        if (d.kind !== 'hold') return;
      }
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

/** `hostBuildSlotPort` for a ship run, guarded by the host disk guard on the worktree root and state root (#2284). */
export function shipHostBuildSlot(
  config: FactoryConfig,
  issue: number,
  log: (kind: EventKind, message: string) => void,
  where: {
    repoRoot: string;
    ghRepo: string;
    paths: { root: string } & Partial<RetentionWhere['paths']>;
    slots?: RunSlotGate;
    octokit?: RetentionReclaimerDeps['octokit'];
  },
): NonNullable<RunPorts['hostBuildSlot']> {
  const guard = createDiskGuard(config, { ...where, stateRoot: where.paths.root });
  const { mergeLock, gitLock } = where.paths;
  // Trees of this issue and of every other build-slot holder in this repo are in flight: never evicted.
  const protectedIssues = (): ReadonlySet<number> =>
    new Set([
      issue,
      ...readHostBuildSlots(hostBuildSlotsDir(), resolveHostMaxBuilds(config))
        .filter((h) => h.repo === where.ghRepo)
        .map((h) => h.issue),
    ]);
  const reclaim =
    mergeLock !== undefined && gitLock !== undefined
      ? retentionReclaimer(
          config,
          { repoRoot: where.repoRoot, ghRepo: where.ghRepo, paths: { mergeLock, gitLock }, protectedIssues, log },
          { octokit: where.octokit },
        )
      : undefined;
  return hostBuildSlotPort(config, where.ghRepo, issue, log, where.slots, {
    guard,
    reclaim: reclaim ? () => reclaim(true) : undefined,
  });
}
