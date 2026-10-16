// src/environment/run-slots.ts — Per-run BUILD/CHECK slot gate composed with the host build slot (#3049).

import { withHostBuildSlot, type AcquireHostBuildSlotOptions } from './host-slots.js';

export interface RunSlotGate {
  readonly max: number;
  readonly active: number;
  /** Resolves with an idempotent release once a slot is owned; `onWait` fires once if it must queue. */
  acquire(onWait?: (active: number, max: number) => void): Promise<() => void>;
}

/** In-process FIFO counting semaphore capping concurrent BUILD/CHECK lanes of one run. */
export function createRunSlotGate(maxConcurrency: number): RunSlotGate {
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
    throw new RangeError('run maxConcurrency must be an integer >= 1');
  }
  let active = 0;
  const waiters: Array<() => void> = [];
  const makeRelease = (): (() => void) => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = waiters.shift();
      if (next) next();
      else active -= 1;
    };
  };
  return {
    max: maxConcurrency,
    get active() {
      return active;
    },
    async acquire(onWait) {
      if (active < maxConcurrency) {
        active += 1;
        return makeRelease();
      }
      onWait?.(active, maxConcurrency);
      await new Promise<void>((resolve) => waiters.push(resolve));
      return makeRelease();
    },
  };
}

/**
 * Runs `fn` while holding a run slot (when a gate is supplied) and a host build slot. The run slot is
 * taken first so a lane blocked by its own run cap never holds a machine-wide host slot.
 */
export async function withRunAndHostBuildSlot<T>(
  opts: AcquireHostBuildSlotOptions & { runSlots?: RunSlotGate },
  fn: () => Promise<T>,
): Promise<T> {
  const { runSlots, ...hostOpts } = opts;
  if (!runSlots) return withHostBuildSlot(hostOpts, fn);
  const release = await runSlots.acquire((a, m) => opts.log?.(`waiting for run build slot (${a}/${m} in use)`));
  try {
    return await withHostBuildSlot(hostOpts, fn);
  } finally {
    release();
  }
}
