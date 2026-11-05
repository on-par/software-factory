// packages/cli/src/cli/run-lane-discovery.ts — lane discovery inside a running `factory run` (#3920).

import { setTimeout as delay } from 'node:timers/promises';

import type { WorkKey } from '@on-par/factory-core';
import type { QueueBackend } from '@on-par/factory-core/internal';

import type { PlannedLane, planRunLanes } from './index.js';

export interface DiscoveredLane {
  planned: PlannedLane;
  /** Work keys currently queued in the lane; a key not seen before restarts a finished lane. */
  keys: string[];
  /** The lane's first queued item and its `factory:order` position, used to rank lanes waiting for a slot (#3958). */
  head?: { position: number | null; issue: number | null };
}

export interface LaneDiscoveryDeps {
  intervalMs: number;
  startLane: (planned: PlannedLane) => Promise<void>;
  discover: () => Promise<DiscoveredLane[]>;
  stopRequested: () => boolean;
  reapExpiredClaims?: () => Promise<void>;
  log: (type: 'lane-start' | 'lane-wait' | 'stopped' | 'warn', message: string, lane?: string) => void;
  /** Resolves after ms, or early when signal aborts. Default: node:timers/promises setTimeout with signal. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Most lanes running at once; lanes over the cap wait for a slot. Unset = no cap (#3958). */
  maxLanes?: number;
  /** Called with the running and waiting lane names after every start, settle and change to the waiting set (#3958). */
  onSlots?: (s: { running: string[]; waiting: string[] }) => void;
}

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> => delay(ms, undefined, { signal });

const nullLast = (a: number | null | undefined, b: number | null | undefined): number => {
  if (a == null) return b == null ? 0 : 1;
  if (b == null) return -1;
  return a - b;
};

/** Queue order for lanes waiting for a slot: lowest head `factory:order` position, then oldest head issue, then lane name (#3958). */
export function rankWaitingLanes(lanes: readonly DiscoveredLane[]): DiscoveredLane[] {
  return [...lanes].sort(
    (a, b) =>
      nullLast(a.head?.position, b.head?.position) ||
      nullLast(a.head?.issue, b.head?.issue) ||
      a.planned.lane.localeCompare(b.planned.lane),
  );
}

/**
 * Starts the initial lanes, then every `intervalMs` (or as soon as all lanes settle) reaps expired claims and
 * starts lanes for work queued since. A lane never runs twice at once. With `maxLanes`, lanes over the cap wait
 * and start in queue order as running lanes settle (#3958). Returns when nothing runs or waits and nothing
 * new was found, or after a stop request once running lanes settle (#3920).
 */
export async function superviseLanes(
  initial: DiscoveredLane[],
  deps: LaneDiscoveryDeps,
): Promise<{ started: string[] }> {
  const running = new Map<string, Promise<void>>();
  const waiting = new Map<string, DiscoveredLane>();
  const seen = new Map<string, Set<string>>();
  const started: string[] = [];
  const sleep = deps.sleep ?? defaultSleep;
  const hasSlot = (): boolean => deps.maxLanes === undefined || running.size < deps.maxLanes;

  const reportSlots = (): void => {
    deps.onSlots?.({
      running: [...running.keys()],
      waiting: rankWaitingLanes([...waiting.values()]).map((l) => l.planned.lane),
    });
  };

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
      .finally(() => {
        running.delete(lane);
        reportSlots();
      });
    running.set(lane, p);
    started.push(lane);
    reportSlots();
  };

  const offer = (d: DiscoveredLane): void => {
    const lane = d.planned.lane;
    if (hasSlot()) {
      waiting.delete(lane);
      start(d);
      return;
    }
    if (!waiting.has(lane)) {
      deps.log('lane-wait', `lane '${lane}' waiting for a slot (${running.size}/${deps.maxLanes} running)`, lane);
    }
    waiting.set(lane, d);
  };

  const fillSlots = (): void => {
    for (const d of rankWaitingLanes([...waiting.values()])) {
      if (!hasSlot()) break;
      waiting.delete(d.planned.lane);
      start(d);
    }
  };

  for (const d of rankWaitingLanes(initial)) {
    if (!running.has(d.planned.lane)) offer(d);
  }
  reportSlots();

  for (;;) {
    const ac = new AbortController();
    try {
      await Promise.race([sleep(deps.intervalMs, ac.signal), Promise.allSettled(running.values())]);
    } catch {
      // an aborted sleep is the expected way for the timer to end
    } finally {
      ac.abort();
    }

    if (!deps.stopRequested()) fillSlots();

    if (deps.stopRequested()) {
      deps.log('stopped', 'lane discovery: stop requested — no new lanes start');
      waiting.clear();
      reportSlots();
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

    const fresh = new Map<string, DiscoveredLane>();
    for (const d of found) {
      const lane = d.planned.lane;
      if (running.has(lane)) continue;
      const known = seen.get(lane);
      if (!d.keys.some((k) => !known?.has(k))) continue;
      const issues = d.planned.issues.filter((issue) => !known?.has(String(issue)));
      fresh.set(lane, { ...d, planned: { ...d.planned, issues } });
    }
    for (const lane of waiting.keys()) {
      if (!fresh.has(lane)) waiting.delete(lane);
    }
    for (const d of rankWaitingLanes([...fresh.values()])) offer(d);
    fillSlots();
    reportSlots();

    if (running.size === 0 && waiting.size === 0) break;
  }

  return { started };
}

/** Attaches each planned lane's current work keys and queue head (#3958). The head is best-effort: a failed lookup leaves it unset. */
export async function withLaneHeads(
  lanes: readonly PlannedLane[],
  opts: { localQueue: boolean; queue: () => QueueBackend },
): Promise<DiscoveredLane[]> {
  const found: DiscoveredLane[] = [];
  for (const [index, planned] of lanes.entries()) {
    if (opts.localQueue) {
      found.push({
        planned,
        keys: planned.issues.map(String),
        head: { position: index, issue: planned.issues[0] ?? null },
      });
      continue;
    }
    const backend = opts.queue();
    const keys = (await backend.list(planned.lane)).map(String);
    let head: DiscoveredLane['head'];
    try {
      const top = await backend.laneHead?.(planned.lane);
      if (top) {
        const issue = Number(top.key);
        head = { position: top.position, issue: Number.isFinite(issue) ? issue : null };
      }
    } catch {
      head = undefined;
    }
    found.push({ planned, keys, head });
  }
  return found;
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
  return withLaneHeads(lanes, { localQueue: input.localQueue, queue: input.queue });
}
