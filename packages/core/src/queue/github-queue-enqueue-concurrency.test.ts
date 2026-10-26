// packages/core/src/queue/github-queue-enqueue-concurrency.test.ts — enqueue/unpark order settle under every two-actor interleaving (#3147).

import { describe, expect, it } from 'vitest';

import { fakeIssueComments } from './fake-issue-comments.js';
import {
  createGithubQueue,
  IN_PROGRESS_LABEL,
  laneLabel,
  PARKED_LABEL,
  QUEUED_LABEL,
  queueOrderLabel,
  type QueueGitHubClient,
  type QueueIssue,
} from './github-queue.js';
import { orderedCandidates } from './queue-order.js';
import { runUnpark, UnparkError } from './unpark.js';

const LANE = laneLabel('L');
const ORDER_PREFIX = 'factory:order:';

/** Grants one waiting actor a step at a time; when both wait, bit `i` of `bits` (then alternation) picks who goes. */
class Scheduler {
  private readonly waiting = new Map<number, () => void>();
  private readonly active = new Set<number>();
  constructor(private readonly bits: number) {}

  turn(actor: number): Promise<void> {
    return new Promise((resolve) => this.waiting.set(actor, resolve));
  }

  async run(actors: Array<() => Promise<unknown>>): Promise<PromiseSettledResult<unknown>[]> {
    const settled = actors.map((actor, i) => {
      this.active.add(i);
      return actor().finally(() => this.active.delete(i));
    });
    const all = Promise.allSettled(settled);
    let step = 0;
    while (this.active.size > 0) {
      await new Promise((resolve) => setImmediate(resolve));
      if (this.waiting.size < this.active.size || this.waiting.size === 0) continue;
      const ready = [...this.waiting.keys()].sort();
      const pick = ready.length === 1 ? ready[0] : ready[step < 12 ? (this.bits >> step) & 1 : step % 2];
      if (ready.length > 1) step += 1;
      const go = this.waiting.get(pick);
      this.waiting.delete(pick);
      go?.();
    }
    return all;
  }
}

type Issues = Array<{ number: number; labels: string[] }>;

function createStore(issues: Issues, turn: (actor: number) => Promise<void> = async () => {}) {
  const state = new Map<number, Set<string>>(issues.map((i) => [i.number, new Set(i.labels)]));
  const listCalls = { count: 0 };
  const members = (want: string[]): QueueIssue[] =>
    [...state]
      .filter(([, set]) => want.every((l) => set.has(l)))
      .map(([number, set]) => ({ number, labels: [...set] }));
  const clientFor = (actor: number): QueueGitHubClient => ({
    async listOpenIssuesWithLabels({ labels }) {
      await turn(actor);
      listCalls.count += 1;
      return members(labels);
    },
    async getIssueLabels({ issue_number }) {
      await turn(actor);
      return [...(state.get(issue_number) ?? [])];
    },
    async addLabels({ issue_number, labels }) {
      await turn(actor);
      const set = state.get(issue_number) ?? new Set<string>();
      for (const label of labels) set.add(label);
      state.set(issue_number, set);
    },
    async removeLabel({ issue_number, name }) {
      await turn(actor);
      if (!state.get(issue_number)?.delete(name))
        throw Object.assign(new Error('Label does not exist'), { status: 404 });
    },
    async ensureLabel() {
      await turn(actor);
      return false;
    },
    ...fakeIssueComments(),
  });
  const orderLabels = (issue: number): string[] =>
    [...(state.get(issue) ?? [])].filter((l) => l.startsWith(ORDER_PREFIX)).sort();
  return { state, clientFor, members, orderLabels, listCalls };
}

const queuedPeers = (count: number): Issues =>
  Array.from({ length: count }, (_, i) => ({
    number: i + 1,
    labels: [QUEUED_LABEL, LANE, queueOrderLabel(i + 1)],
  }));

const queueOf = (
  client: QueueGitHubClient,
  onRepair?: Parameters<typeof createGithubQueue>[0]['onOrderCollisionRepaired'],
) => createGithubQueue({ client, owner: 'o', repo: 'r', claimantId: 'aaa-1', onOrderCollisionRepaired: onRepair });

const SCHEDULES = Array.from({ length: 1 << 12 }, (_, bits) => bits);

describe('enqueue settle under concurrency (#3147)', () => {
  it('two concurrent enqueuers in one lane end with unique positions under every interleaving', async () => {
    for (const bits of SCHEDULES) {
      const sched = new Scheduler(bits);
      const store = createStore(queuedPeers(5), (actor) => sched.turn(actor));
      await sched.run([
        () => queueOf(store.clientFor(0)).enqueue('L', [10]),
        () => queueOf(store.clientFor(1)).enqueue('L', [11]),
      ]);
      const lane = store.members([LANE]);
      const positions = lane.map((m) => store.orderLabels(m.number));
      expect(
        positions.every((p) => p.length === 1),
        `schedule ${bits}: ${JSON.stringify(positions)}`,
      ).toBe(true);
      expect(new Set(positions.flat()).size, `schedule ${bits}: ${JSON.stringify(positions)}`).toBe(lane.length);
    }
  }, 120_000);

  it('two concurrent unparks of one issue leave exactly one order label and orderedCandidates does not throw', async () => {
    for (const bits of SCHEDULES) {
      const sched = new Scheduler(bits);
      const store = createStore([...queuedPeers(3), { number: 7, labels: [PARKED_LABEL, LANE] }], (actor) =>
        sched.turn(actor),
      );
      const results = await sched.run(
        [0, 1].map((actor) => () => runUnpark({ client: store.clientFor(actor), owner: 'o', repo: 'r', issue: 7 })),
      );
      const failures = results.filter((r) => r.status === 'rejected');
      expect(failures.length, `schedule ${bits}`).toBeLessThanOrEqual(1);
      for (const f of failures) expect((f as PromiseRejectedResult).reason).toBeInstanceOf(UnparkError);
      expect(store.orderLabels(7), `schedule ${bits}`).toHaveLength(1);
      expect(() => orderedCandidates('L', store.members([LANE])), `schedule ${bits}`).not.toThrow();
    }
  }, 120_000);
});

describe('enqueue settle step (#3147)', () => {
  it('collapses several order labels, malformed ones included, to the lowest', async () => {
    const store = createStore(queuedPeers(3));
    const client = store.clientFor(0);
    const addLabels = client.addLabels.bind(client);
    client.addLabels = async (input) => {
      await addLabels(input);
      await addLabels({ ...input, labels: [queueOrderLabel(9), queueOrderLabel(12), `${ORDER_PREFIX}zz`] });
    };
    const [res] = await queueOf(client).enqueue('L', [10]);
    expect(res).toMatchObject({ issue: 10, outcome: 'queued', position: 4 });
    expect(store.orderLabels(10)).toEqual([queueOrderLabel(4)]);
    expect(res?.orderRepairs).toBeUndefined();
  });

  it('moves the queued issue, not an in-progress holder, and reports the repair', async () => {
    const store = createStore(queuedPeers(3));
    const client = store.clientFor(0);
    const addLabels = client.addLabels.bind(client);
    client.addLabels = async (input) => {
      await addLabels(input);
      store.state.set(20, new Set([IN_PROGRESS_LABEL, LANE, queueOrderLabel(4)])); // a concurrent writer took 4
    };
    const repairs: unknown[] = [];
    const [res] = await queueOf(client, (r) => repairs.push(r)).enqueue('L', [10]);
    const repair = { lane: 'L', position: 4, kept: 20, moved: [{ issue: 10, to: 5 }] };
    expect(res).toMatchObject({ outcome: 'queued', position: 5, orderRepairs: [repair] });
    expect(repairs).toEqual([repair]);
    expect(store.orderLabels(20)).toEqual([queueOrderLabel(4)]);
    expect(store.orderLabels(10)).toEqual([queueOrderLabel(5)]);
  });

  it('stops after 3 settle scans when a collision never clears', async () => {
    const store = createStore([...queuedPeers(3), { number: 11, labels: [QUEUED_LABEL, LANE, queueOrderLabel(99)] }]);
    const client = store.clientFor(0);
    const list = client.listOpenIssuesWithLabels.bind(client);
    client.listOpenIssuesWithLabels = async (input) => {
      const found = await list(input);
      const shared = found.find((m) => m.number === 10)?.labels.find((l) => l.startsWith(ORDER_PREFIX));
      // #11 always appears to share #10's position once #10 is labelled
      return found.map((m) => (m.number === 11 && shared ? { ...m, labels: [QUEUED_LABEL, LANE, shared] } : m));
    };
    const [res] = await queueOf(client).enqueue('L', [10]);
    expect(res?.outcome).toBe('queued');
    expect(store.listCalls.count).toBeLessThanOrEqual(1 + 3);
    expect(res?.orderRepairs).toHaveLength(3);
  });

  it('fails closed when the order label was removed concurrently', async () => {
    const store = createStore(queuedPeers(3));
    const client = store.clientFor(0);
    const getLabels = client.getIssueLabels.bind(client);
    client.getIssueLabels = async (input) =>
      (await getLabels(input)).filter((l) => !(input.issue_number === 10 && l.startsWith(ORDER_PREFIX)));
    const [res] = await queueOf(client).enqueue('L', [10]);
    expect(res).toMatchObject({ issue: 10, outcome: 'failed' });
    expect(res?.detail).toContain('removed concurrently');
  });
});
