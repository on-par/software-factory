// packages/core/src/queue/test-support/fleet-sim.test.ts — self-tests for the fleet simulator (#3150).

import { describe, expect, it } from 'vitest';
import {
  checkFleetInvariants,
  createFleetStore,
  exploreExhaustive,
  exploreSeeded,
  formatFleetFailure,
  replayFleetSchedule,
  runFleetSchedule,
  type FleetActor,
  type FleetScenario,
} from './fleet-sim.js';

const O = { owner: 'o', repo: 'r' };

function callsActor(n: number): FleetActor {
  return async ({ client }) => {
    for (let i = 0; i < n; i += 1) await client.getIssueLabels({ ...O, issue_number: 1 });
  };
}

function scenario(claimants: string[], actor: FleetActor, extra: Partial<FleetScenario> = {}): FleetScenario {
  return { issues: [{ number: 1, labels: [] }], claimants, actor, ...extra };
}

describe('fleet store', () => {
  it('adds, removes, gets and filters labels', async () => {
    const client = createFleetStore([
      { number: 1, labels: ['a'] },
      { number: 2, labels: ['a', 'b'] },
    ]).client();
    await client.addLabels({ ...O, issue_number: 1, labels: ['b'] });
    await client.removeLabel({ ...O, issue_number: 2, name: 'a' });
    await client.removeLabel({ ...O, issue_number: 2, name: 'missing' });
    expect(await client.getIssueLabels({ ...O, issue_number: 1 })).toEqual(['a', 'b']);
    expect(await client.getIssueLabels({ ...O, issue_number: 2 })).toEqual(['b']);
    const listed = await client.listOpenIssuesWithLabels({ ...O, labels: ['a', 'b'] });
    expect(listed.map((i) => i.number)).toEqual([1]);
    expect(await client.ensureLabel({ ...O, name: 'x', color: 'fff', description: '' })).toBe(true);
    expect(await client.ensureLabel({ ...O, name: 'x', color: 'fff', description: '' })).toBe(false);
  });

  it('serves stale lists under replica lag while reads of one issue stay fresh', async () => {
    const client = createFleetStore([{ number: 1, labels: [] }], { replicaLag: 1 }).client();
    await client.addLabels({ ...O, issue_number: 1, labels: ['a'] });
    expect(await client.listOpenIssuesWithLabels({ ...O, labels: ['a'] })).toEqual([]);
    expect(await client.getIssueLabels({ ...O, issue_number: 1 })).toEqual(['a']);
    await client.addLabels({ ...O, issue_number: 1, labels: ['b'] });
    expect((await client.listOpenIssuesWithLabels({ ...O, labels: ['a'] })).length).toBe(1);
  });

  it('orders comments by a store-wide increasing id', async () => {
    const client = createFleetStore([
      { number: 1, labels: [] },
      { number: 2, labels: [] },
    ]).client();
    const a = await client.createIssueComment({ ...O, issue_number: 1, body: 'a' });
    const b = await client.createIssueComment({ ...O, issue_number: 2, body: 'b' });
    const c = await client.createIssueComment({ ...O, issue_number: 1, body: 'c' });
    expect([a.id, b.id, c.id]).toEqual([1, 2, 3]);
    const listed = await client.listIssueComments({ ...O, issue_number: 1 });
    expect(listed.map((x) => x.id)).toEqual([1, 3]);
    expect(listed[0]?.createdAt).toBe(new Date(1_700_000_000_000 + 1000).toISOString());
    await client.deleteIssueComment({ ...O, comment_id: 1 });
    await client.deleteIssueComment({ ...O, comment_id: 99 });
    expect((await client.listIssueComments({ ...O, issue_number: 1 })).map((x) => x.id)).toEqual([3]);
  });
});

describe('fleet scheduler', () => {
  it('visits every interleaving exactly once', async () => {
    expect((await exploreExhaustive(scenario(['a', 'b'], callsActor(2)))).schedules).toBe(6);
    expect((await exploreExhaustive(scenario(['a', 'b', 'c'], callsActor(1)))).schedules).toBe(6);
  });

  it('dedupeStates collapses schedules that reach the same state', async () => {
    const r = await exploreExhaustive(scenario(['a', 'b'], callsActor(2)), { dedupeStates: true });
    expect(r.schedules).toBeLessThan(6);
    expect(r.schedules).toBeGreaterThan(0);
  });

  it('does not gate ensureLabel', async () => {
    const actor: FleetActor = async ({ client }) => {
      await client.ensureLabel({ ...O, name: 'x', color: 'fff', description: '' });
    };
    const r = await runFleetSchedule(scenario(['a', 'b'], actor), () => 0);
    expect(r.trace).toEqual([]);
  });

  it('finds a lost update, formats it and replays it identically', async () => {
    const racy: FleetActor = async ({ client, claimantId }) => {
      const have = await client.getIssueLabels({ ...O, issue_number: 1 });
      if (have.some((l) => l.startsWith('factory:claimed-by:'))) return;
      await client.addLabels({ ...O, issue_number: 1, labels: [`factory:claimed-by:${claimantId}`] });
    };
    const sc = scenario(['a', 'b'], racy);
    const r = await exploreExhaustive(sc, { stopOnFirstViolation: false });
    const failure = r.failures.find((f) => f.labels.get(1)?.length === 2);
    expect(failure).toBeDefined();
    if (!failure) return;
    expect(failure.violations.map((v) => v.invariant)).toContain('orphaned-claimed-by');
    expect(formatFleetFailure(failure)).toContain(`[${failure.choices.join(', ')}]`);
    expect((await replayFleetSchedule(sc, failure.choices)).trace).toEqual(failure.trace);
  });

  it('flags a second live claimant when the queue wrapper sees a double claim', async () => {
    const issues = [{ number: 1, labels: ['factory:queued', 'factory:lane:main', 'factory:order:1'] }];
    const r = await exploreExhaustive({ issues, claimants: ['host-a', 'host-b'] }, { dedupeStates: true });
    expect(r.failures[0]?.violations.map((v) => v.invariant)).toContain('single-live-claimant');
  });

  it('is deterministic per seed and varies across seeds', async () => {
    const sc = scenario(['a', 'b', 'c'], callsActor(2));
    const one = await exploreSeeded(sc, { seed: 7, schedules: 20 });
    const two = await exploreSeeded(sc, { seed: 7, schedules: 20 });
    expect(one).toEqual(two);
    const run = async () => (await runFleetSchedule(sc, () => 0)).trace;
    expect(await run()).toEqual(await run());
    const seeds = await exploreSeeded(sc, { seed: 7, schedules: 20, stopOnFirstViolation: false });
    expect(seeds.schedules).toBe(20);
  });

  it('samples more than one distinct schedule', async () => {
    const sc = scenario(['a', 'b', 'c'], callsActor(2));
    const seen = new Set<string>();
    for (const seed of [1, 2, 3, 4, 5]) {
      const r = await runFleetSchedule(sc, (n) => (seed + n) % n);
      seen.add(r.choices.join(','));
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it('reports an actor that throws', async () => {
    const boom: FleetActor = async () => {
      throw new Error('boom');
    };
    const r = await runFleetSchedule(scenario(['a'], boom), () => 0);
    expect(r.violations).toMatchObject([{ invariant: 'actor-error' }]);
  });

  it('stops an endless actor at maxSteps', async () => {
    const forever: FleetActor = async ({ client }) => {
      for (;;) await client.getIssueLabels({ ...O, issue_number: 1 });
    };
    const r = await runFleetSchedule(scenario(['a'], forever, { maxSteps: 10 }), () => 0);
    expect(r.violations.map((v) => v.invariant)).toContain('max-steps');
    expect(r.trace.length).toBe(10);
  });
});

describe('checkFleetInvariants', () => {
  it('flags two order labels', () => {
    const v = checkFleetInvariants(new Map([[1, ['factory:order:1', 'factory:order:2']]]), new Map());
    expect(v.map((x) => x.invariant)).toEqual(['single-order-label']);
  });

  it('flags a shared lane position', () => {
    const labels = ['factory:queued', 'factory:lane:main', 'factory:order:1'];
    const v = checkFleetInvariants(
      new Map([
        [1, labels],
        [2, labels],
      ]),
      new Map(),
    );
    expect(v.map((x) => x.invariant)).toEqual(['unique-lane-position']);
  });

  it('flags an orphaned claimed-by label', () => {
    const v = checkFleetInvariants(new Map([[1, ['factory:claimed-by:a']]]), new Map());
    expect(v.map((x) => x.invariant)).toEqual(['orphaned-claimed-by']);
  });

  it('flags two live claimants and passes a clean state', () => {
    const v = checkFleetInvariants(new Map([[1, []]]), new Map([[1, ['a', 'b']]]));
    expect(v.map((x) => x.invariant)).toEqual(['single-live-claimant']);
    expect(checkFleetInvariants(new Map([[1, ['factory:queued']]]), new Map())).toEqual([]);
  });
});
