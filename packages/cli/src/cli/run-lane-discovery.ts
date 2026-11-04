// packages/cli/src/cli/run-lane-discovery.ts — lane discovery inside a running `factory run` (#3920).

import { setTimeout as delay } from 'node:timers/promises';

import type { WorkKey } from '@on-par/factory-core';
import type { QueueBackend } from '@on-par/factory-core/internal';

import type { PlannedLane, planRunLanes } from './index.js';

export interface DiscoveredLane {
  planned: PlannedLane;
  /** Work keys currently queued in the lane; a key not seen before restarts a finished lane. */
  keys: string[];
}

export interface LaneDiscoveryDeps {
  intervalMs: number;
  startLane: (planned: PlannedLane) => Promise<void>;
  discover: () => Promise<DiscoveredLane[]>;
  stopRequested: () => boolean;
  reapExpiredClaims?: () => Promise<void>;
  log: (type: 'lane-start' | 'stopped' | 'warn', message: string, lane?: string) => void;
  /** Resolves after ms, or early when signal aborts. Default: node:timers/promises setTimeout with signal. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> => delay(ms, undefined, { signal });

/**
 * Starts the initial lanes, then every `intervalMs` (or as soon as all lanes settle) reaps expired claims and
 * starts lanes for work queued since. A lane never runs twice at once. Returns when nothing runs and nothing
 * new was found, or after a stop request once running lanes settle (#3920).
 */
export async function superviseLanes(
  initial: DiscoveredLane[],
  deps: LaneDiscoveryDeps,
): Promise<{ started: string[] }> {
  const running = new Map<string, Promise<void>>();
  const seen = new Map<string, Set<string>>();
  const started: string[] = [];
  const sleep = deps.sleep ?? defaultSleep;

  const start = (d: DiscoveredLane): void => {
    const lane = d.planned.lane;
    const keys = seen.get(lane) ?? new Set<string>();
    for (const k of d.keys) keys.add(k);
    seen.set(lane, keys);
    const count = d.planned.issues.length;
    deps.log('lane-start', `lane '${lane}' started${count ? ` (${count} issues)` : ''}`, lane);
    const p = deps
      .startLane(d.planned)
      .catch((e: unknown) => deps.log('warn', `lane '${lane}' failed: ${errorMessage(e)}`, lane))
      .finally(() => running.delete(lane));
    running.set(lane, p);
    started.push(lane);
  };

  for (const d of initial) {
    if (!running.has(d.planned.lane)) start(d);
  }

  for (;;) {
    const ac = new AbortController();
    try {
      await Promise.race([sleep(deps.intervalMs, ac.signal), Promise.allSettled(running.values())]);
    } catch {
      // an aborted sleep is the expected way for the timer to end
    } finally {
      ac.abort();
    }

    if (deps.stopRequested()) {
      deps.log('stopped', 'lane discovery: stop requested — no new lanes start');
      await Promise.allSettled(running.values());
      break;
    }

    try {
      await deps.reapExpiredClaims?.();
    } catch (e) {
      deps.log('warn', `lane discovery: claim reap failed: ${errorMessage(e)}`);
    }

    let found: DiscoveredLane[] = [];
    try {
      found = await deps.discover();
    } catch (e) {
      deps.log('warn', `lane discovery failed: ${errorMessage(e)}`);
    }

    for (const d of found) {
      const lane = d.planned.lane;
      if (running.has(lane)) continue;
      const known = seen.get(lane);
      if (!d.keys.some((k) => !known?.has(k))) continue;
      const issues = d.planned.issues.filter((issue) => !known?.has(String(issue)));
      start({ planned: { ...d.planned, issues }, keys: d.keys });
    }

    if (running.size === 0) break;
  }

  return { started };
}

/** Re-plans lanes from the queue and attaches each lane's current work keys (#3920). */
export async function discoverQueuedLanes(input: {
  localQueue: boolean;
  readLocalQueue: () => string | null;
  queue: () => QueueBackend;
  onUnshippable?: (key: WorkKey) => void;
  planRunLanes: typeof planRunLanes;
}): Promise<DiscoveredLane[]> {
  const { lanes } = await input.planRunLanes({
    localQueue: input.localQueue,
    readLocalQueue: input.readLocalQueue,
    queue: input.queue,
    onUnshippable: input.onUnshippable,
  });
  const found: DiscoveredLane[] = [];
  for (const planned of lanes) {
    const keys = input.localQueue ? planned.issues.map(String) : (await input.queue().list(planned.lane)).map(String);
    found.push({ planned, keys });
  }
  return found;
}
