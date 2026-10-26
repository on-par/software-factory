// packages/core/src/queue/order-repair.test.ts — enqueue converges under concurrent hosts: one order label per issue, unique lane positions (#3147).

import { describe, expect, it } from 'vitest';

import { createEnqueuers } from './github-queue-enqueue.js';
import { laneLabel, PARKED_LABEL, QUEUED_LABEL, type QueueGitHubClient } from './github-queue.js';
import { dedupeOrderLabels, MAX_ORDER_REPAIR_ATTEMPTS, repairOrderCollision } from './order-repair.js';
import { orderedCandidates } from './queue-order.js';
import { fakeIssueComments } from './fake-issue-comments.js';
import { runUnpark } from './unpark.js';

const base = { owner: 'o', repo: 'r' };
const ORDER = 'factory:order:';
const orders = (labels: readonly string[]): string[] => labels.filter((l) => l.startsWith(ORDER));
const positionOf = (labels: readonly string[]): number => Number(orders(labels)[0]?.slice(ORDER.length));

/** In-memory client. Every call first awaits `gate(actor)`, so a test decides who runs next. */
function fakeGitHub(initial: Array<[number, string[]]>, gate: (actor: string) => Promise<void> = async () => {}) {
  const state = new Map<number, string[]>(initial.map(([n, l]) => [n, [...l]]));
  const clientFor = (actor: string): QueueGitHubClient => ({
    listOpenIssuesWithLabels: async ({ labels }) => {
      await gate(actor);
      return [...state.entries()]
        .filter(([, have]) => labels.every((w) => have.includes(w)))
        .map(([number, have]) => ({ number, labels: [...have] }));
    },
    getIssueLabels: async ({ issue_number }) => {
      await gate(actor);
      return [...(state.get(issue_number) ?? [])];
    },
    addLabels: async ({ issue_number, labels }) => {
      await gate(actor);
      const have = state.get(issue_number) ?? [];
      state.set(issue_number, [...have, ...labels.filter((l) => !have.includes(l))]);
    },
    removeLabel: async ({ issue_number, name }) => {
      await gate(actor);
      const have = state.get(issue_number) ?? [];
      if (!have.includes(name)) throw Object.assign(new Error('Label does not exist'), { status: 404 });
      state.set(
        issue_number,
        have.filter((l) => l !== name),
      );
    },
    ensureLabel: async () => {
      await gate(actor);
      return false;
    },
    ...fakeIssueComments(),
  });
  return { state, clientFor };
}

/** Deterministic scheduler: each pending client call is released in the order `choices` names the actor. */
function scheduler(choices: readonly string[]) {
  const pending: Array<{ actor: string; release: () => void }> = [];
  let step = 0;
  const gate = (actor: string): Promise<void> =>
    new Promise<void>((resolve) => pending.push({ actor, release: resolve }));
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  async function drive(done: () => boolean): Promise<void> {
    for (let guard = 0; guard < 10_000 && !done(); guard++) {
      await settle();
      if (pending.length === 0) continue;
      const want = choices[step++ % choices.length];
      const idx = pending.findIndex((p) => p.actor === want);
      pending.splice(idx === -1 ? 0 : idx, 1)[0]?.release();
    }
  }
  return { gate, drive };
}

describe('concurrent enqueue', () => {
  const lanePeers = (): Array<[number, string[]]> => [
    [1, [QUEUED_LABEL, laneLabel('ops'), `${ORDER}1`]],
    [10, []],
    [11, []],
  ];

  async function race(choices: readonly string[]) {
    const sched = scheduler(choices);
    const gh = fakeGitHub(lanePeers(), sched.gate);
    let finished = 0;
    const run = (actor: string, issue: number) =>
      createEnqueuers(gh.clientFor(actor), 'o', 'r')
        .enqueue('ops', [issue])
        .finally(() => finished++);
    const both = Promise.all([run('A', 10), run('B', 11)]);
    await sched.drive(() => finished === 2);
    await both;
    return gh.state;
  }

  const patterns: string[][] = [];
  for (let bits = 0; bits < 256; bits++) {
    patterns.push(Array.from({ length: 8 }, (_, i) => ((bits >> i) & 1 ? 'B' : 'A')));
  }

  it('every interleaving of two enqueuers ends with unique lane positions', async () => {
    for (const choices of patterns) {
      const state = await race(choices);
      const a = state.get(10) ?? [];
      const b = state.get(11) ?? [];
      const label = choices.join('');
      expect(orders(a), label).toHaveLength(1);
      expect(orders(b), label).toHaveLength(1);
      const positions = [positionOf(state.get(1) ?? []), positionOf(a), positionOf(b)];
      expect(new Set(positions).size, `${label}: ${positions.join(',')}`).toBe(3);
    }
  });

  it('repairs the contended case: read-read-write-write', async () => {
    const state = await race(['A', 'B', 'A', 'B']);
    expect(positionOf(state.get(10) ?? [])).toBe(2);
    expect(positionOf(state.get(11) ?? [])).toBe(3);
  });
});

describe('concurrent unpark', () => {
  it('two concurrent unparks of one issue leave exactly one order label and orderedCandidates does not throw', async () => {
    const parked = (): Array<[number, string[]]> => [
      [1, [QUEUED_LABEL, laneLabel('ops'), `${ORDER}1`]],
      [7, [PARKED_LABEL, laneLabel('ops')]],
    ];
    for (let bits = 0; bits < 256; bits++) {
      const choices = Array.from({ length: 8 }, (_, i) => ((bits >> i) & 1 ? 'B' : 'A'));
      const sched = scheduler(choices);
      const gh = fakeGitHub(parked(), sched.gate);
      let finished = 0;
      const run = (actor: string) =>
        runUnpark({ ...base, client: gh.clientFor(actor), issue: 7 })
          .catch(() => undefined) // the loser may fail (not-parked) or find the label already gone
          .finally(() => finished++);
      const both = Promise.all([run('A'), run('B')]);
      await sched.drive(() => finished === 2);
      await both;
      const labels = gh.state.get(7) ?? [];
      expect(orders(labels), choices.join('')).toHaveLength(1);
      const members = [...gh.state.entries()]
        .filter(([, l]) => l.includes(QUEUED_LABEL) && l.includes(laneLabel('ops')))
        .map(([number, l]) => ({ number, labels: l }));
      expect(() => orderedCandidates('ops', members)).not.toThrow();
    }
  });
});

describe('dedupeOrderLabels', () => {
  it('keeps the lowest valid label and drops the rest, malformed ones included', async () => {
    const gh = fakeGitHub([[5, [`${ORDER}4`, `${ORDER}2`, `${ORDER}abc`, `${ORDER}0`, 'bug']]]);
    expect(await dedupeOrderLabels(gh.clientFor('A'), 'o', 'r', 5)).toBe(2);
    expect(gh.state.get(5)).toEqual([`${ORDER}2`, 'bug']);
  });

  it('changes nothing when no order label is valid', async () => {
    const gh = fakeGitHub([[5, [`${ORDER}abc`]]]);
    expect(await dedupeOrderLabels(gh.clientFor('A'), 'o', 'r', 5)).toBeUndefined();
    expect(gh.state.get(5)).toEqual([`${ORDER}abc`]);
  });

  it('tolerates a label another host already removed (404)', async () => {
    const gh = fakeGitHub([[5, [`${ORDER}1`, `${ORDER}2`]]]);
    const client = gh.clientFor('A');
    const removeLabel = client.removeLabel;
    client.removeLabel = async (input) => {
      await removeLabel(input); // the other host got there first
      await removeLabel(input);
    };
    expect(await dedupeOrderLabels(client, 'o', 'r', 5)).toBe(1);
    expect(gh.state.get(5)).toEqual([`${ORDER}1`]);
  });
});

describe('repairOrderCollision', () => {
  const lane = (...rest: Array<[number, string[]]>): Array<[number, string[]]> =>
    rest.map(([n, l]) => [n, [QUEUED_LABEL, laneLabel('ops'), ...l]]);

  it('moves the higher-numbered issue to the lane max + 1 and reports from/to', async () => {
    const gh = fakeGitHub(lane([3, [`${ORDER}1`]], [4, [`${ORDER}2`]], [9, [`${ORDER}1`]]));
    const seen: unknown[] = [];
    const out = await repairOrderCollision({
      client: gh.clientFor('A'),
      ...base,
      lane: 'ops',
      issue: 9,
      position: 1,
      onRepair: (r) => seen.push(r),
    });
    expect(out.position).toBe(3);
    expect(gh.state.get(9)).toContain(`${ORDER}3`);
    expect(orders(gh.state.get(9) ?? [])).toHaveLength(1);
    expect(seen).toEqual([{ lane: 'ops', issue: 9, from: 1, to: 3, sharedWith: [3], attempt: 1 }]);
  });

  it('moves a higher-numbered sharer when it is the lower issue that sees the collision', async () => {
    const gh = fakeGitHub(lane([3, [`${ORDER}1`]], [9, [`${ORDER}1`]]));
    const out = await repairOrderCollision({ client: gh.clientFor('A'), ...base, lane: 'ops', issue: 3, position: 1 });
    expect(out.position).toBe(1);
    expect(out.repairs).toMatchObject([{ issue: 9, from: 1, to: 2 }]);
    expect(gh.state.get(9)).toEqual([QUEUED_LABEL, laneLabel('ops'), `${ORDER}2`]);
  });

  it('does nothing when the position is unique', async () => {
    const gh = fakeGitHub(lane([3, [`${ORDER}1`]], [9, [`${ORDER}2`]]));
    const out = await repairOrderCollision({ client: gh.clientFor('A'), ...base, lane: 'ops', issue: 9, position: 2 });
    expect(out).toEqual({ position: 2, repairs: [] });
  });

  it('ignores a sharer that itself carries several order labels', async () => {
    const gh = fakeGitHub(lane([3, [`${ORDER}1`, `${ORDER}5`]], [9, [`${ORDER}1`]]));
    const out = await repairOrderCollision({ client: gh.clientFor('A'), ...base, lane: 'ops', issue: 9, position: 1 });
    expect(out).toEqual({ position: 1, repairs: [] });
  });

  it(`stops after ${MAX_ORDER_REPAIR_ATTEMPTS} attempts and reports the collision as exhausted`, async () => {
    const gh = fakeGitHub(lane([3, [`${ORDER}1`]], [9, [`${ORDER}1`]]));
    const client = gh.clientFor('A');
    // Another host keeps landing on whatever position issue 9 just moved to.
    const addLabels = client.addLabels;
    client.addLabels = async (input) => {
      await addLabels(input);
      if (input.issue_number === 9) await addLabels({ ...input, issue_number: 3, labels: input.labels });
      if (input.issue_number === 9) {
        const have = gh.state.get(3) ?? [];
        gh.state.set(3, [...have.filter((l) => !l.startsWith(ORDER)), ...input.labels]);
      }
    };
    const out = await repairOrderCollision({ client, ...base, lane: 'ops', issue: 9, position: 1 });
    expect(out.repairs.filter((r) => !r.exhausted)).toHaveLength(MAX_ORDER_REPAIR_ATTEMPTS);
    expect(out.repairs.at(-1)).toMatchObject({ exhausted: true, issue: 9 });
  });
});
