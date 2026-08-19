// src/bus/index.ts — In-process lane lifecycle bus (#591).
// Additive fan-out only: `.factory/events.ndjson` stays the canonical sink (ADR-0002),
// and nothing emitted here may change pipeline behavior.
import { EventEmitter } from 'node:events';

import type { LaneLifecycleEvent, LaneLifecyclePhase, LaneLifecycleStatus } from '@on-par/contracts';

export type { LaneLifecycleEvent, LaneLifecyclePhase, LaneLifecycleStatus };

export type LaneLifecycleListener = (event: LaneLifecycleEvent) => void;

export interface LifecycleBus {
  emit(event: LaneLifecycleEvent): void;
  /** Subscribe; returns an unsubscribe function. */
  on(listener: LaneLifecycleListener): () => void;
}

const CHANNEL = 'lifecycle';

export function createLifecycleBus(): LifecycleBus {
  const emitter = new EventEmitter();
  // Parallel lanes plus a server subscriber can exceed Node's default 10-listener
  // warning threshold; unbounded is correct for a fan-out with no back pressure.
  emitter.setMaxListeners(0);

  return {
    emit(event) {
      emitter.emit(CHANNEL, event);
    },
    on(listener) {
      // A throwing subscriber must never reach the phase that emitted (ADR: the bus
      // cannot change pipeline behavior), and must not stop the other subscribers.
      const guarded = (event: LaneLifecycleEvent): void => {
        try {
          listener(event);
        } catch {
          // isolated on purpose
        }
      };
      emitter.on(CHANNEL, guarded);
      return () => {
        emitter.off(CHANNEL, guarded);
      };
    },
  };
}

/** Process-wide default bus — phases emit here when the caller injects none. */
export const lifecycleBus: LifecycleBus = createLifecycleBus();

export interface LifecycleContext {
  bus?: LifecycleBus;
  phase: LaneLifecyclePhase;
  laneId?: string;
  issueId: string | number;
  worktreePath: string;
}

function emitLifecycle(ctx: LifecycleContext, status: LaneLifecycleStatus, detail: string): void {
  const issueId = String(ctx.issueId);
  (ctx.bus ?? lifecycleBus).emit({
    ts: new Date().toISOString(),
    laneId: ctx.laneId ?? `issue-${issueId}`,
    issueId,
    phase: ctx.phase,
    status,
    detail,
    worktreePath: ctx.worktreePath,
  });
}

/**
 * Emit `started`, run the phase, then emit exactly one `done`/`failed`. The result is
 * returned and thrown errors re-thrown, both untouched.
 */
export async function withLifecycle<T>(
  ctx: LifecycleContext,
  run: () => Promise<T>,
  succeeded: (result: T) => boolean,
  describe?: (result: T) => string,
): Promise<T> {
  emitLifecycle(ctx, 'started', `${ctx.phase} started`);
  let result: T;
  try {
    result = await run();
  } catch (err) {
    emitLifecycle(ctx, 'failed', `${ctx.phase} threw: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
  const ok = succeeded(result);
  emitLifecycle(ctx, ok ? 'done' : 'failed', describe?.(result) ?? `${ctx.phase} ${ok ? 'done' : 'failed'}`);
  return result;
}
