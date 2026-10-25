// packages/cli/src/cli/run-lane-load-hold.ts — runLane's host load claim gate (#3048)

import type { getFactoryPaths } from '@on-par/factory-core';
import { formatLoadHold } from '@on-par/factory-core/internal';
import type { LoadGuardDecision, logEvent } from '@on-par/factory-core/internal';

interface LoadHoldIo {
  lane: string;
  paths: Pick<ReturnType<typeof getFactoryPaths>, 'events' | 'stop'>;
  emitEvent: typeof logEvent;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  pathExists: (path: string) => boolean;
}

const decide = (guard: () => LoadGuardDecision): LoadGuardDecision => {
  try {
    return guard();
  } catch {
    return { kind: 'claim' };
  }
};

/** Holds the claim while the host is loaded: one `warn` per retry until load recovers or STOP appears. */
export async function holdForLoad(guard: () => LoadGuardDecision, io: LoadHoldIo): Promise<'claim' | 'stopped'> {
  for (let d = decide(guard); d.kind === 'hold'; d = decide(guard)) {
    const retryAt = new Date(io.now().getTime() + d.retryMs);
    io.emitEvent(io.paths.events, 'warn', io.lane, formatLoadHold(io.lane, d, retryAt), { lane: io.lane });
    await io.sleep(d.retryMs);
    if (io.pathExists(io.paths.stop)) return 'stopped';
  }
  return 'claim';
}
