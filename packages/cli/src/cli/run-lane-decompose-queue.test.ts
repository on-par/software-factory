// packages/cli/src/cli/run-lane-decompose-queue.test.ts — a decomposed issue's children are queued in the GitHub queue before the lane moves on (#3539)

import {
  createGithubQueue,
  IN_PROGRESS_LABEL,
  laneLabel,
  QUEUED_LABEL,
  queueOrderLabel,
  type QueueGitHubClient,
  type QueueIssue,
} from '@on-par/factory-core/internal';
import { describe, expect, it } from 'vitest';

import { IssueDecomposedError, laneQueueDeps } from './index.js';
import { queueDecomposedChildren } from './run-lane-decompose.js';
import { runLane } from './run-lane.js';

const paths: any = { events: '/repo/.factory/events.ndjson', stop: '/repo/.factory/STOP' };
const P = 100;
const D = 200;
const [A, B, C] = [101, 102, 103];
const LANE = laneLabel('bugfix');

function makeEnv(opts: { failQueuedOn?: number } = {}) {
  const store = new Map<number, Set<string>>([
    [P, new Set([QUEUED_LABEL, LANE, queueOrderLabel(4), 'factory:decomposed'])],
    [D, new Set([QUEUED_LABEL, LANE, queueOrderLabel(5)])],
    [A, new Set(['factory:decomposed-child'])],
    [B, new Set()],
    [C, new Set()],
  ]);
  const log: string[] = [];
  const client: QueueGitHubClient = {
    async listOpenIssuesWithLabels({ labels }) {
      const result: QueueIssue[] = [];
      for (const [number, set] of store) {
        if (labels.every((l) => set.has(l))) result.push({ number, labels: [...set] });
      }
      return result;
    },
    async getIssueLabels({ issue_number }) {
      return [...(store.get(issue_number) ?? new Set<string>())];
    },
    async addLabels({ issue_number, labels }) {
      if (issue_number === opts.failQueuedOn && labels.includes(QUEUED_LABEL)) throw new Error('github 502');
      log.push(`add ${issue_number} ${labels.join(',')}`);
      const set = store.get(issue_number) ?? new Set<string>();
      for (const label of labels) set.add(label);
      store.set(issue_number, set);
    },
    async removeLabel({ issue_number, name }) {
      log.push(`remove ${issue_number} ${name}`);
      store.get(issue_number)?.delete(name);
    },
    async createIssueComment() {
      return { id: 1 };
    },
    async listIssueComments() {
      return [];
    },
    async deleteIssueComment() {},
    async ensureLabel() {
      return false;
    },
  };
  const queue = () => createGithubQueue({ client, owner: 'o', repo: 'r', claimantId: 'mini-1' });
  const events: Array<{ type: string; issue: unknown; message: string }> = [];
  const lane = (stopAfterParent: boolean) => {
    const shipped: number[] = [];
    const promise = () =>
      runLane('bugfix', [], '/repo', 'o/r', paths, {
        ...laneQueueDeps(queue(), 'bugfix'),
        ship: async (issue) => {
          log.push(`ship ${issue}`);
          shipped.push(issue);
          if (issue === P) throw new IssueDecomposedError('split', [A, B, C]);
          return `factory/${issue}`;
        },
        waitMerge: async () => {},
        pathExists: (path) => stopAfterParent && path === paths.stop && shipped.includes(P),
        emitEvent: (_p, type, issue, message) => {
          events.push({ type, issue, message: String(message) });
        },
      });
    return { shipped, promise };
  };
  return { store, log, events, lane };
}

describe('runLane decomposition on the GitHub queue (#3539)', () => {
  it('queues decomposed children in the GitHub queue with queued, lane and one order label', async () => {
    const env = makeEnv();
    await env.lane(true).promise();

    for (const [n, pos] of [
      [A, 5],
      [B, 6],
      [C, 7],
    ] as const) {
      const labels = env.store.get(n) ?? new Set<string>();
      expect(labels.has(QUEUED_LABEL)).toBe(true);
      expect(labels.has(LANE)).toBe(true);
      expect([...labels].filter((l) => l.startsWith('factory:order:'))).toEqual([queueOrderLabel(pos)]);
    }
    expect(env.store.get(D)?.has(queueOrderLabel(8))).toBe(true);
  });

  it('leaves the decomposed parent with factory:decomposed and no queued, in-progress or order label', async () => {
    const env = makeEnv();
    await env.lane(true).promise();

    const labels = [...(env.store.get(P) ?? [])];
    expect(labels).toContain('factory:decomposed');
    expect(labels).not.toContain(QUEUED_LABEL);
    expect(labels).not.toContain(IN_PROGRESS_LABEL);
    expect(labels.some((l) => l.startsWith('factory:order:'))).toBe(false);
  });

  it('writes child queue labels before settling the parent or shipping the first child', async () => {
    const env = makeEnv();
    const run = env.lane(false);
    await run.promise();

    const at = (prefix: string) => env.log.findIndex((e) => e.startsWith(prefix));
    const lastChildAdd = Math.max(...[A, B, C].map((n) => at(`add ${n} ${QUEUED_LABEL}`)));
    expect(lastChildAdd).toBeGreaterThan(-1);
    expect(lastChildAdd).toBeLessThan(at(`remove ${P} ${IN_PROGRESS_LABEL}`));
    expect(lastChildAdd).toBeLessThan(at(`ship ${A}`));
    expect(run.shipped).toEqual([P, A, B, C, D]);
    for (const n of [A, B, C]) {
      expect(at(`add ${n} ${IN_PROGRESS_LABEL}`)).toBeLessThan(at(`ship ${n}`));
    }
  });

  it('a fresh lane after a stop claims the decomposed children in build order', async () => {
    const env = makeEnv();
    await env.lane(true).promise();
    const second = env.lane(false);
    await second.promise();

    expect(second.shipped).toEqual([A, B, C, D]);
  });

  it('a failed child enqueue emits a fail event naming the child and factory:queued and is not counted as decomposed', async () => {
    const env = makeEnv({ failQueuedOn: B });
    const run = env.lane(false);
    await run.promise();

    const fail = env.events.find((e) => e.type === 'fail' && e.issue === B);
    expect(fail?.message).toContain(`#${B}`);
    expect(fail?.message).toContain(QUEUED_LABEL);
    expect(env.events.some((e) => e.type === 'decompose_filed')).toBe(false);
    expect(env.events.find((e) => e.message.startsWith('lane complete'))?.message).toContain('0 decomposed');
    expect(run.shipped).toContain(B);
  });
});

describe('queueDecomposedChildren (#3539)', () => {
  const failEvents = () => {
    const events: Array<{ type: string; issue: unknown; message: string; lane: unknown }> = [];
    const emitEvent: any = (_p: string, type: string, issue: unknown, message: unknown, extra: { lane?: unknown }) => {
      events.push({ type, issue, message: String(message), lane: extra?.lane });
    };
    return { events, emitEvent };
  };

  it('a failed shift of later order labels emits a fail on the parent and is not clean, though every child queued', async () => {
    const { events, emitEvent } = failEvents();
    const res = await queueDecomposedChildren(
      async (_parent, children) => ({
        results: children.map((issue, i) => ({ issue, outcome: 'queued' as const, position: 5 + i })),
        placement: 'tail',
        detail: 'remove boom',
      }),
      P,
      [A, B],
      'bugfix',
      paths.events,
      emitEvent,
    );

    expect(res).toEqual({ unwritten: [], clean: false });
    expect(events).toEqual([
      {
        type: 'fail',
        issue: P,
        lane: 'bugfix',
        message: `decomposed children of #${P} queued at the tail of lane 'bugfix', not behind #${P}: shifting later factory:order labels failed (remove boom)`,
      },
    ]);
  });

  it('a thrown enqueue emits one fail on the parent naming every child and leaves them all unwritten', async () => {
    const { events, emitEvent } = failEvents();
    const res = await queueDecomposedChildren(
      async () => {
        throw new Error('github 502');
      },
      P,
      [A, B, C],
      'bugfix',
      paths.events,
      emitEvent,
    );

    expect(res).toEqual({ unwritten: [A, B, C], clean: false });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'fail', issue: P, lane: 'bugfix' });
    expect(events[0]?.message).toContain(`decomposed children #${A}, #${B}, #${C} of #${P} not queued`);
    expect(events[0]?.message).toContain(`could not add label '${QUEUED_LABEL}' on lane 'bugfix'`);
    expect(events[0]?.message).toContain('github 502');
  });
});
