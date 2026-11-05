// packages/cli/src/cli/run-lane-discovery.test.ts — lane discovery inside a running factory run (#3920).

import { describe, expect, it, vi } from 'vitest';

import { workKeyFromIssue } from '@on-par/factory-core';
import type { QueueBackend } from '@on-par/factory-core/internal';

import type { PlannedLane, planRunLanes } from './index.js';
import { discoverQueuedLanes, rankWaitingLanes, superviseLanes } from './run-lane-discovery.js';
import type { DiscoveredLane, LaneDiscoveryDeps } from './run-lane-discovery.js';

const lane = (name: string, issues: number[] = [], keys = issues.map(String)): DiscoveredLane => ({
  planned: { lane: name, issues, deps: {} },
  keys,
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A sleep that resolves only when the test calls tick() (or when the abort signal fires). */
function manualSleep() {
  const waiters: Array<() => void> = [];
  return {
    sleep: (_ms: number, signal: AbortSignal) =>
      new Promise<void>((resolve) => {
        waiters.push(resolve);
        signal.addEventListener('abort', () => resolve());
      }),
    tick: () => waiters.splice(0).forEach((w) => w()),
  };
}

const settle = () => new Promise<void>((r) => setImmediate(r));

function harness(over: Partial<LaneDiscoveryDeps> = {}) {
  const gates = new Map<string, ReturnType<typeof deferred>[]>();
  const startLane = vi.fn((p: PlannedLane) => {
    const d = deferred();
    gates.set(p.lane, [...(gates.get(p.lane) ?? []), d]);
    return d.promise;
  });
  const log = vi.fn();
  const clock = manualSleep();
  const deps: LaneDiscoveryDeps = {
    intervalMs: 1000,
    startLane,
    discover: async () => [],
    stopRequested: () => false,
    log,
    sleep: clock.sleep,
    ...over,
  };
  return { deps, startLane, log, clock, finish: (name: string) => gates.get(name)!.shift()!.resolve() };
}

describe('superviseLanes (#3920)', () => {
  it('starts a new lane discovered mid-run and logs lane-start for it', async () => {
    const discover = vi.fn(async () => [lane('a'), lane('b'), lane('c', [], ['3'])]);
    const h = harness({ discover });
    const done = superviseLanes([lane('a'), lane('b')], h.deps);
    await settle();
    expect(h.startLane).toHaveBeenCalledTimes(2);
    h.clock.tick();
    await settle();
    expect(h.startLane.mock.calls.map(([p]) => p.lane)).toEqual(['a', 'b', 'c']);
    expect(h.log).toHaveBeenCalledWith('lane-start', "lane 'c' started", 'c');
    h.finish('a');
    h.finish('b');
    h.finish('c');
    discover.mockResolvedValue([]);
    expect((await done).started).toEqual(['a', 'b', 'c']);
  });

  it('restarts a finished lane when an unseen work key is queued in it', async () => {
    const discover = vi.fn(async () => [] as DiscoveredLane[]);
    const h = harness({ discover });
    const done = superviseLanes([lane('c')], h.deps);
    await settle();
    discover.mockResolvedValueOnce([lane('c', [], ['7'])]);
    h.finish('c');
    await settle();
    expect(h.startLane).toHaveBeenCalledTimes(2);
    h.finish('c');
    expect((await done).started).toEqual(['c', 'c']);
  });

  it('never starts a second copy of a running lane', async () => {
    const discover = vi.fn(async () => [lane('a', [], ['9'])]);
    const h = harness({ discover });
    const done = superviseLanes([lane('a')], h.deps);
    await settle();
    h.clock.tick();
    await settle();
    expect(discover).toHaveBeenCalled();
    expect(h.startLane).toHaveBeenCalledTimes(1);
    discover.mockResolvedValue([]);
    h.finish('a');
    await done;
  });

  it('launches discovered lanes through the same startLane as startup lanes', async () => {
    const h = harness({ discover: async () => [lane('a'), lane('z', [], ['1'])] });
    const startLane = h.deps.startLane;
    const done = superviseLanes([lane('a')], h.deps);
    await settle();
    h.clock.tick();
    await settle();
    expect(h.deps.startLane).toBe(startLane);
    expect(h.startLane.mock.calls.map(([p]) => p.lane)).toEqual(['a', 'z']);
    h.finish('a');
    h.finish('z');
    await settle();
    // z's key was already seen, so nothing restarts and the run drains.
    await done;
    expect(h.startLane).toHaveBeenCalledTimes(2);
  });

  it('returns once every lane settled and discovery finds no unseen work', async () => {
    const h = harness();
    const done = superviseLanes([lane('a'), lane('b')], h.deps);
    await settle();
    h.finish('a');
    h.finish('b');
    // No clock.tick(): the post-drain pass must not wait for the interval.
    await expect(done).resolves.toEqual({ started: ['a', 'b'] });
  });

  it('does not restart a lane whose only queued work it was already started with', async () => {
    const h = harness({ discover: async () => [lane('a', [], ['5'])] });
    const done = superviseLanes([lane('a', [], ['5'])], h.deps);
    await settle();
    h.finish('a');
    await expect(done).resolves.toEqual({ started: ['a'] });
    expect(h.startLane).toHaveBeenCalledTimes(1);
  });

  it('starts no new lane after a stop is requested and waits for running lanes', async () => {
    const discover = vi.fn(async () => [lane('n', [], ['1'])]);
    const h = harness({ discover, stopRequested: () => true });
    let resolved = false;
    const done = superviseLanes([lane('a')], h.deps).then((r) => {
      resolved = true;
      return r;
    });
    await settle();
    h.clock.tick();
    await settle();
    expect(h.log.mock.calls.filter(([t]) => t === 'stopped')).toHaveLength(1);
    expect(discover).not.toHaveBeenCalled();
    expect(resolved).toBe(false);
    h.finish('a');
    await expect(done).resolves.toEqual({ started: ['a'] });
    expect(h.startLane).toHaveBeenCalledTimes(1);
  });

  it('reaps expired claims on every discovery pass', async () => {
    const reap = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(undefined);
    const h = harness({ reapExpiredClaims: reap });
    const done = superviseLanes([lane('a')], h.deps);
    await settle();
    h.clock.tick();
    await settle();
    h.clock.tick();
    await settle();
    expect(reap).toHaveBeenCalledTimes(2);
    expect(h.log).toHaveBeenCalledWith('warn', 'lane discovery: claim reap failed: boom');
    h.finish('a');
    await done;
  });

  it('logs warn and keeps running when discover throws', async () => {
    const discover = vi.fn().mockRejectedValueOnce(new Error('nope')).mockResolvedValue([]);
    const h = harness({ discover });
    const done = superviseLanes([lane('a')], h.deps);
    await settle();
    h.clock.tick();
    await settle();
    expect(h.log).toHaveBeenCalledWith('warn', 'lane discovery failed: nope');
    h.finish('a');
    await expect(done).resolves.toEqual({ started: ['a'] });
  });

  it('survives a lane whose startLane rejects', async () => {
    const h = harness({ startLane: async () => Promise.reject(new Error('lane died')) });
    await expect(superviseLanes([lane('a')], h.deps)).resolves.toEqual({ started: ['a'] });
    expect(h.log).toHaveBeenCalledWith('warn', "lane 'a' failed: lane died", 'a');
  });

  it('logs the issue count for a seeded lane', async () => {
    const h = harness();
    const done = superviseLanes([lane('a', [1, 2])], h.deps);
    await settle();
    expect(h.log).toHaveBeenCalledWith('lane-start', "lane 'a' started (2 issues)", 'a');
    h.finish('a');
    await done;
  });

  it('uses the default timer sleep when none is injected', async () => {
    const h = harness({ sleep: undefined, intervalMs: 5 });
    const done = superviseLanes([lane('a')], h.deps);
    await settle();
    await new Promise((r) => setTimeout(r, 30));
    h.finish('a');
    await expect(done).resolves.toEqual({ started: ['a'] });
  });
});

const headed = (name: string, position: number | null, issue: number | null = null): DiscoveredLane => ({
  ...lane(name),
  head: { position, issue },
});

describe('superviseLanes maxLanes (#3958)', () => {
  it('runs at most maxLanes lanes and holds the rest as waiting', async () => {
    const onSlots = vi.fn();
    const h = harness({ maxLanes: 4, onSlots });
    const names = ['a', 'b', 'c', 'd', 'e', 'f'];
    const done = superviseLanes(
      names.map((n, i) => headed(n, i + 1)),
      h.deps,
    );
    await settle();
    expect(h.startLane.mock.calls.map(([p]) => p.lane)).toEqual(['a', 'b', 'c', 'd']);
    expect(onSlots).toHaveBeenLastCalledWith({ running: ['a', 'b', 'c', 'd'], waiting: ['e', 'f'] });
    expect(h.log).toHaveBeenCalledWith('lane-wait', "lane 'e' waiting for a slot (4/4 running)", 'e');
    for (const n of ['a', 'b', 'c', 'd']) h.finish(n);
    await settle();
    for (const n of ['e', 'f']) h.finish(n);
    await done;
  });

  it('starts the next waiting lane in queue order when a running lane drains', async () => {
    const withKeys = (d: DiscoveredLane): DiscoveredLane => ({ ...d, keys: ['1'] });
    const initial = [headed('a', 1), headed('late', 9), headed('early', 2)].map(withKeys);
    const h = harness({ maxLanes: 1, discover: async () => initial });
    const done = superviseLanes(initial, h.deps);
    await settle();
    expect(h.startLane.mock.calls.map(([p]) => p.lane)).toEqual(['a']);
    h.finish('a');
    await settle();
    expect(h.startLane.mock.calls.map(([p]) => p.lane)).toEqual(['a', 'early']);
    h.finish('early');
    await settle();
    h.finish('late');
    await expect(done).resolves.toEqual({ started: ['a', 'early', 'late'] });
  });

  it('rankWaitingLanes orders by head factory:order position then oldest head issue', () => {
    const ranked = rankWaitingLanes([
      headed('none', null),
      lane('unset'),
      headed('p2-new', 2, 50),
      headed('p2-old', 2, 10),
      headed('p1', 1, 99),
      headed('p2-null', 2, null),
    ]);
    expect(ranked.map((l) => l.planned.lane)).toEqual(['p1', 'p2-old', 'p2-new', 'p2-null', 'none', 'unset']);
  });

  it('starts every lane when maxLanes is unset', async () => {
    const h = harness();
    const done = superviseLanes([lane('a'), lane('b'), lane('c'), lane('d'), lane('e')], h.deps);
    await settle();
    expect(h.startLane).toHaveBeenCalledTimes(5);
    expect(h.log.mock.calls.filter(([t]) => t === 'lane-wait')).toHaveLength(0);
    for (const n of ['a', 'b', 'c', 'd', 'e']) h.finish(n);
    await done;
  });

  it('a discovered lane waits while the cap is reached', async () => {
    const onSlots = vi.fn();
    const discover = vi.fn(async () => [lane('a'), headed('new', 1)].map((d) => ({ ...d, keys: [...d.keys, '7'] })));
    const h = harness({ maxLanes: 1, onSlots, discover });
    const done = superviseLanes([lane('a')], h.deps);
    await settle();
    h.clock.tick();
    await settle();
    expect(h.startLane).toHaveBeenCalledTimes(1);
    expect(onSlots).toHaveBeenLastCalledWith({ running: ['a'], waiting: ['new'] });
    h.finish('a');
    await settle();
    expect(h.startLane.mock.calls.map(([p]) => p.lane)).toEqual(['a', 'new']);
    expect(onSlots).toHaveBeenLastCalledWith({ running: ['new'], waiting: ['a'] });
    discover.mockResolvedValue([]);
    h.finish('new');
    await settle();
    h.finish('a');
    await done;
  });

  it('does not end the run while lanes are waiting', async () => {
    const h = harness({ maxLanes: 1, discover: async () => [lane('b', [], ['1'])] });
    let resolved = false;
    const done = superviseLanes([lane('a', [], ['1']), lane('b', [], ['1'])], h.deps).then((r) => {
      resolved = true;
      return r;
    });
    await settle();
    h.finish('a');
    await settle();
    expect(resolved).toBe(false);
    expect(h.startLane.mock.calls.map(([p]) => p.lane)).toEqual(['a', 'b']);
    h.finish('b');
    await expect(done).resolves.toEqual({ started: ['a', 'b'] });
  });

  it('starts no waiting lane after a stop request', async () => {
    let stop = false;
    const onSlots = vi.fn();
    const h = harness({ maxLanes: 1, onSlots, stopRequested: () => stop });
    const done = superviseLanes(
      [headed('a', 1), headed('b', 2)].map((d) => ({ ...d, keys: ['1'] })),
      h.deps,
    );
    await settle();
    stop = true;
    h.finish('a');
    await expect(done).resolves.toEqual({ started: ['a'] });
    expect(h.startLane).toHaveBeenCalledTimes(1);
    expect(onSlots).toHaveBeenLastCalledWith({ running: [], waiting: [] });
  });
});

describe('discoverQueuedLanes (#3920)', () => {
  it('discovers new local-queue entries and seeds a restarted lane with only unseen issues', async () => {
    let content = 'app 5\n';
    const plan: typeof planRunLanes = async (input) => {
      const issues = [...(input.readLocalQueue() ?? '').matchAll(/app (\d+)/g)].map((m) => Number(m[1]));
      return { lanes: [{ lane: 'app', issues, deps: {} }], diagnostics: [] };
    };
    const found = () =>
      discoverQueuedLanes({
        localQueue: true,
        readLocalQueue: () => content,
        queue: () => {
          throw new Error('no backend under --local-queue');
        },
        planRunLanes: plan,
      });
    const initial = await found();
    expect(initial[0].keys).toEqual(['5']);

    content = 'app 5\napp 6\n';
    const h = harness({ discover: found });
    const done = superviseLanes(initial, h.deps);
    await settle();
    h.finish('app');
    await settle();
    expect(h.startLane.mock.calls[1][0].issues).toEqual([6]);
    h.finish('app');
    await done;
  });

  it('lists GitHub keys per lane through QueueBackend.list', async () => {
    const list = vi.fn(async (l?: string) => (l === 'x' ? [workKeyFromIssue(11), workKeyFromIssue(12)] : []));
    const queue: Pick<QueueBackend, 'list'> = { list };
    const found = await discoverQueuedLanes({
      localQueue: false,
      readLocalQueue: () => null,
      queue: () => queue as QueueBackend,
      planRunLanes: async () => ({
        lanes: [{ lane: 'x', issues: [], deps: {} }],
        diagnostics: [],
      }),
    });
    expect(list).toHaveBeenCalledWith('x');
    expect(found).toEqual([{ planned: { lane: 'x', issues: [], deps: {} }, keys: ['11', '12'] }]);
  });
});

describe('lane heads (#3958)', () => {
  const planned = { lane: 'x', issues: [], deps: {} };
  const discover = (queue: Partial<QueueBackend>) =>
    discoverQueuedLanes({
      localQueue: false,
      readLocalQueue: () => null,
      queue: () => ({ list: async () => [workKeyFromIssue(11)], ...queue }) as QueueBackend,
      planRunLanes: async () => ({ lanes: [planned], diagnostics: [] }),
    });

  it('attaches the GitHub laneHead position and issue', async () => {
    const found = await discover({ laneHead: async () => ({ key: workKeyFromIssue(11), position: 3 }) });
    expect(found[0].head).toEqual({ position: 3, issue: 11 });
  });

  it('leaves head unset when laneHead throws or is missing', async () => {
    expect((await discover({ laneHead: async () => Promise.reject(new Error('x')) }))[0].head).toBeUndefined();
    expect((await discover({}))[0].head).toBeUndefined();
  });

  it('ranks local-queue lanes by their plan order', async () => {
    const found = await discoverQueuedLanes({
      localQueue: true,
      readLocalQueue: () => null,
      queue: () => {
        throw new Error('no backend');
      },
      planRunLanes: async () => ({
        lanes: [
          { lane: 'a', issues: [4, 5], deps: {} },
          { lane: 'b', issues: [], deps: {} },
        ],
        diagnostics: [],
      }),
    });
    expect(found.map((f) => f.head)).toEqual([
      { position: 0, issue: 4 },
      { position: 1, issue: null },
    ]);
  });
});
