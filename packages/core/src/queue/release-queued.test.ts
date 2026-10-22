// packages/core/src/queue/release-queued.test.ts — release(issue, 'queued') never writes a malformed queue entry (#3193).

import { describe, expect, it } from 'vitest';

import {
  CLAIM_EXPIRES_LABEL_PREFIX,
  CLAIMED_BY_LABEL_PREFIX,
  createGithubQueue,
  IN_PROGRESS_LABEL,
  laneLabel,
  PARKED_LABEL,
  QUEUED_LABEL,
  queueOrderLabel,
  type QueueGitHubClient,
  type QueueIssue,
} from './github-queue.js';
import { fakeIssueComments } from './fake-issue-comments.js';

function createFakeStore(issues: Array<{ number: number; labels: string[] }>) {
  const state = new Map<number, Set<string>>(issues.map((i) => [i.number, new Set(i.labels)]));
  const createdLabels = new Set<string>();
  const calls: string[] = [];

  const client: QueueGitHubClient = {
    async listOpenIssuesWithLabels({ labels }) {
      calls.push('listOpenIssuesWithLabels');
      const result: QueueIssue[] = [];
      for (const [number, labelSet] of state) {
        if (labels.every((l) => labelSet.has(l))) {
          result.push({ number, labels: [...labelSet] });
        }
      }
      return result;
    },
    async getIssueLabels({ issue_number }) {
      calls.push('getIssueLabels');
      return [...(state.get(issue_number) ?? new Set<string>())];
    },
    async addLabels({ issue_number, labels }) {
      calls.push('addLabels');
      // Yield before mutating so concurrent claimNext calls can interleave — this is
      // what makes the simulated-race tests below an actual race, not a fixed order.
      await Promise.resolve();
      const set = state.get(issue_number) ?? new Set<string>();
      for (const label of labels) set.add(label);
      state.set(issue_number, set);
    },
    async removeLabel({ issue_number, name }) {
      calls.push('removeLabel');
      state.get(issue_number)?.delete(name);
    },
    ...fakeIssueComments(),
    async ensureLabel({ name }) {
      calls.push('ensureLabel');
      createdLabels.add(name);
      return false;
    },
  };
  return { state, createdLabels, calls, client };
}

describe("release(issue, 'queued')", () => {
  it('does not queue a parked issue (#3193)', async () => {
    const { client, state } = createFakeStore([
      { number: 2319, labels: [PARKED_LABEL, laneLabel('self-repair')] },
      {
        number: 2320,
        labels: [PARKED_LABEL, laneLabel('self-repair'), IN_PROGRESS_LABEL, `${CLAIMED_BY_LABEL_PREFIX}aaa-1`],
      },
    ]);
    const queue = createGithubQueue({ client, owner: 'o', repo: 'r', claimantId: 'aaa-1' });

    await queue.release(2319, 'queued');
    await queue.release(2320, 'queued');

    for (const n of [2319, 2320]) {
      const labels = state.get(n) ?? new Set<string>();
      expect(labels.has(PARKED_LABEL)).toBe(true);
      expect(labels.has(QUEUED_LABEL)).toBe(false);
      expect(labels.has(IN_PROGRESS_LABEL)).toBe(false);
      expect([...labels].some((l) => l.startsWith(CLAIMED_BY_LABEL_PREFIX))).toBe(false);
      expect([...labels].some((l) => l.startsWith('factory:order:'))).toBe(false);
    }
  });

  it('appends a claimed issue with no order label at the lane tail (#3193)', async () => {
    const { client, state } = createFakeStore([
      { number: 1, labels: [QUEUED_LABEL, laneLabel('self-repair'), queueOrderLabel(1)] },
      { number: 2, labels: [QUEUED_LABEL, laneLabel('self-repair'), queueOrderLabel(2)] },
      {
        number: 10,
        labels: [
          IN_PROGRESS_LABEL,
          `${CLAIMED_BY_LABEL_PREFIX}aaa-1`,
          `${CLAIM_EXPIRES_LABEL_PREFIX}123`,
          laneLabel('self-repair'),
        ],
      },
    ]);
    const queue = createGithubQueue({ client, owner: 'o', repo: 'r', claimantId: 'aaa-1' });

    await queue.release(10, 'queued');

    expect([...(state.get(10) ?? [])].sort()).toEqual(
      [QUEUED_LABEL, laneLabel('self-repair'), queueOrderLabel(3)].sort(),
    );
  });

  it('replaces a malformed order label with the lane tail position (#3193)', async () => {
    const { client, state } = createFakeStore([
      { number: 1, labels: [QUEUED_LABEL, laneLabel('self-repair'), queueOrderLabel(1)] },
      { number: 10, labels: [laneLabel('self-repair'), 'factory:order:abc'] },
    ]);
    const queue = createGithubQueue({ client, owner: 'o', repo: 'r', claimantId: 'aaa-1' });

    await queue.release(10, 'queued');

    expect([...(state.get(10) ?? [])].sort()).toEqual(
      [QUEUED_LABEL, laneLabel('self-repair'), queueOrderLabel(2)].sort(),
    );
  });

  it('keeps the existing order position on a claimed issue (#3193)', async () => {
    const { client, state } = createFakeStore([
      {
        number: 10,
        labels: [IN_PROGRESS_LABEL, `${CLAIMED_BY_LABEL_PREFIX}aaa-1`, laneLabel('self-repair'), queueOrderLabel(4)],
      },
    ]);
    const queue = createGithubQueue({ client, owner: 'o', repo: 'r', claimantId: 'aaa-1' });

    await queue.release(10, 'queued');

    expect([...(state.get(10) ?? [])].sort()).toEqual(
      [QUEUED_LABEL, laneLabel('self-repair'), queueOrderLabel(4)].sort(),
    );
  });

  it('does not add factory:queued when there is no order label and no single lane label (#3193)', async () => {
    const { client, state } = createFakeStore([
      { number: 10, labels: [IN_PROGRESS_LABEL, `${CLAIMED_BY_LABEL_PREFIX}aaa-1`] },
      { number: 11, labels: [IN_PROGRESS_LABEL, laneLabel('a'), laneLabel('b')] },
    ]);
    const queue = createGithubQueue({ client, owner: 'o', repo: 'r', claimantId: 'aaa-1' });

    await queue.release(10, 'queued');
    await queue.release(11, 'queued');

    expect(state.get(10)?.has(QUEUED_LABEL)).toBe(false);
    expect(state.get(11)?.has(QUEUED_LABEL)).toBe(false);
  });
});
