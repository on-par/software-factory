// packages/cli/src/cli/run-lane-discovery.test.ts — lane discovery inside a running factory run (#3920).

import { describe, expect, it, vi } from 'vitest';

import { workKeyFromIssue } from '@on-par/factory-core';
import type { QueueBackend } from '@on-par/factory-core/internal';

import type { PlannedLane, planRunLanes } from './index.js';
import { discoverQueuedLanes, superviseLanes } from './run-lane-discovery.js';
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
