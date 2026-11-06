// packages/cli/src/cli/run-lane-disk-hold.ts — runLane's host disk claim gate (#2284)

import type { getFactoryPaths } from '@on-par/factory-core';
import { formatDiskHold } from '@on-par/factory-core/internal';
import type { DiskGuardDecision, logEvent } from '@on-par/factory-core/internal';

interface DiskHoldIo {
  lane: string;
  paths: Pick<ReturnType<typeof getFactoryPaths>, 'events' | 'stop'>;
  emitEvent: typeof logEvent;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  pathExists: (path: string) => boolean;
}

const decide = (guard: () => DiskGuardDecision): DiskGuardDecision => {
  try {
    return guard();
  } catch {
    return { kind: 'claim' };
  }
};

/** Holds the claim while disk is low: reclaims retained worktrees first (#3970), then one `disk_low` event per episode, `warn` per retry, until space recovers or STOP appears. */
export async function holdForDisk(
  guard: () => DiskGuardDecision,
  io: DiskHoldIo,
  reclaim?: () => Promise<unknown>,
): Promise<'claim' | 'stopped'> {
  let first = true;
  for (let d = decide(guard); d.kind === 'hold'; d = decide(guard)) {
    // Free evictable retained trees before holding the claim; a reclaim failure never blocks the hold (#3970).
    if (reclaim) {
      await reclaim().catch(() => {});
      d = decide(guard);
      if (d.kind !== 'hold') break;
    }
    const retryAt = new Date(io.now().getTime() + d.retryMs);
    const line = formatDiskHold(`lane '${io.lane}' not claiming:`, d, retryAt);
    io.emitEvent(io.paths.events, first ? 'disk_low' : 'warn', io.lane, line, { lane: io.lane });
    first = false;
    await io.sleep(d.retryMs);
    if (io.pathExists(io.paths.stop)) return 'stopped';
  }
  return 'claim';
}
