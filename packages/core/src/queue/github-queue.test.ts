// packages/core/src/queue/github-queue.test.ts — Claim/release/list over the factory:* label taxonomy (#824).

import { describe, expect, it } from 'vitest';

import {
  CLAIMED_BY_LABEL_PREFIX,
  claimedByLabel,
  createGithubQueue,
  createOctokitQueueClient,
  defaultClaimantId,
  IN_PROGRESS_LABEL,
  LANE_LABEL_PREFIX,
  laneLabel,
  MAX_LABEL_NAME_LENGTH,
  PARKED_LABEL,
  QUEUED_LABEL,
  QUEUE_ORDER_LABEL_PREFIX,
  queueOrderLabel,
  queueLabelSpecs,
  type QueueGitHubClient,
  type QueueIssue,
} from './github-queue.js';

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
    async ensureLabel({ name }) {
      calls.push('ensureLabel');
      createdLabels.add(name);
    },
  };

  return { state, createdLabels, calls, client };
}

describe('label taxonomy', () => {
  it('exposes the taxonomy constants', () => {
    expect(QUEUED_LABEL).toBe('factory:queued');
    expect(IN_PROGRESS_LABEL).toBe('factory:in-progress');
    expect(PARKED_LABEL).toBe('factory:parked');
    expect(LANE_LABEL_PREFIX).toBe('factory:lane:');
    expect(QUEUE_ORDER_LABEL_PREFIX).toBe('factory:order:');
    expect(CLAIMED_BY_LABEL_PREFIX).toBe('factory:claimed-by:');
  });

  it('laneLabel builds the parameterised lane label', () => {
    expect(laneLabel('build')).toBe('factory:lane:build');
  });

  it('laneLabel slugifies an arbitrary lane name', () => {
    expect(laneLabel('Feature/Big Lane')).toBe('factory:lane:feature-big-lane');
  });

  it('laneLabel truncates a very long lane name to fit the label limit', () => {
    expect(laneLabel('x'.repeat(200)).length).toBeLessThanOrEqual(MAX_LABEL_NAME_LENGTH);
  });

  it('queueOrderLabel renders a positive one-based position', () => {
    expect(queueOrderLabel(42)).toBe('factory:order:42');
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('queueOrderLabel rejects an invalid position: %s', (position) => {
    expect(() => queueOrderLabel(position)).toThrow(RangeError);
  });

  it('claimedByLabel truncates a very long claimant id to fit the label limit', () => {
    expect(claimedByLabel('y'.repeat(200)).length).toBeLessThanOrEqual(MAX_LABEL_NAME_LENGTH);
  });

  it('falls back to "unknown" when nothing survives slugification', () => {
    expect(laneLabel('!!!')).toBe('factory:lane:unknown');
    expect(claimedByLabel('!!!')).toBe('factory:claimed-by:unknown');
  });
});

describe('defaultClaimantId', () => {
  it('combines a slugified host with the pid', () => {
    expect(defaultClaimantId('My Host.local', 4242)).toBe('my-host-local-4242');
  });

  it('defaults to the real hostname/pid and stays within the label limit', () => {
    const id = defaultClaimantId();
    expect(id.length).toBeGreaterThan(0);
    expect(claimedByLabel(id).length).toBeLessThanOrEqual(MAX_LABEL_NAME_LENGTH);
  });
});

describe('queueLabelSpecs', () => {
  it('returns the five taxonomy specs for a lane/claimant, in order', () => {
    const specs = queueLabelSpecs('build', 'aaa-1');
    expect(specs.map((s) => s.name)).toEqual([
      QUEUED_LABEL,
      'factory:lane:build',
      IN_PROGRESS_LABEL,
      'factory:claimed-by:aaa-1',
      PARKED_LABEL,
    ]);
  });
});

describe('list', () => {
  it('returns matching queued issue numbers in explicit lane order, without mutating state', async () => {
    const { client, calls } = createFakeStore([
      { number: 1055, labels: [QUEUED_LABEL, laneLabel('build'), queueOrderLabel(1)] },
      { number: 993, labels: [QUEUED_LABEL, laneLabel('build'), queueOrderLabel(2)] },
      { number: 3, labels: [QUEUED_LABEL, laneLabel('other'), queueOrderLabel(1)] },
    ]);
    const queue = createGithubQueue({ client, owner: 'o', repo: 'r', claimantId: 'aaa-1' });

    const result = await queue.list('build');

    expect(result).toEqual([1055, 993]);
    expect(calls).toEqual(['listOpenIssuesWithLabels']);
  });

  it('returns an empty array when nothing matches', async () => {
    const { client } = createFakeStore([]);
    const queue = createGithubQueue({ client, owner: 'o', repo: 'r', claimantId: 'aaa-1' });

    expect(await queue.list('build')).toEqual([]);
  });

  it('rejects queued issues without one valid unique position per lane', async () => {
    const { client } = createFakeStore([
      { number: 1, labels: [QUEUED_LABEL, laneLabel('build')] },
      { number: 2, labels: [QUEUED_LABEL, laneLabel('build'), queueOrderLabel(1)] },
      { number: 3, labels: [QUEUED_LABEL, laneLabel('build'), queueOrderLabel(1)] },
    ]);
    const queue = createGithubQueue({ client, owner: 'o', repo: 'r', claimantId: 'aaa-1' });

    await expect(queue.list('build')).rejects.toThrow('invalid GitHub queue state');
  });

  it('rejects duplicate positions within a lane', async () => {
    const { client } = createFakeStore([
      { number: 1, labels: [QUEUED_LABEL, laneLabel('build'), queueOrderLabel(1)] },
      { number: 2, labels: [QUEUED_LABEL, laneLabel('build'), queueOrderLabel(1)] },
    ]);
    const queue = createGithubQueue({ client, owner: 'o', repo: 'r', claimantId: 'aaa-1' });

    await expect(queue.claimNext('build')).rejects.toThrow('both have position 1');
  });

  it.each([
    [[QUEUED_LABEL, laneLabel('build'), 'factory:order:0']],
    [[QUEUED_LABEL, laneLabel('build'), queueOrderLabel(1), queueOrderLabel(2)]],
  ])('rejects malformed or multiple order labels', async (labels) => {
    const { client } = createFakeStore([{ number: 1, labels }]);
    const queue = createGithubQueue({ client, owner: 'o', repo: 'r', claimantId: 'aaa-1' });

    await expect(queue.claimNext('build')).rejects.toThrow('invalid GitHub queue state');
  });
});

describe('migrateLocalQueue', () => {
  it('applies queued, lane, and independent per-lane order labels in local-file order', async () => {
    const { client, createdLabels, state } = createFakeStore([
      { number: 1055, labels: [] },
      { number: 993, labels: [] },
      { number: 200, labels: [] },
      { number: 1056, labels: [] },
    ]);
    const queue = createGithubQueue({ client, owner: 'o', repo: 'r', claimantId: 'aaa-1' });

    await queue.migrateLocalQueue([
      { lane: 'daw', issue: 1055, lineNo: 1 },
      { lane: 'daw', issue: 993, lineNo: 2 },
      { lane: 'docs', issue: 200, lineNo: 3 },
      { lane: 'daw', issue: 1056, lineNo: 4 },
    ]);

    expect(state.get(1055)).toEqual(new Set([QUEUED_LABEL, laneLabel('daw'), queueOrderLabel(1)]));
    expect(state.get(993)).toEqual(new Set([QUEUED_LABEL, laneLabel('daw'), queueOrderLabel(2)]));
    expect(state.get(200)).toEqual(new Set([QUEUED_LABEL, laneLabel('docs'), queueOrderLabel(1)]));
    expect(state.get(1056)).toEqual(new Set([QUEUED_LABEL, laneLabel('daw'), queueOrderLabel(3)]));
    expect(createdLabels).toEqual(
      new Set([
        QUEUED_LABEL,
        laneLabel('daw'),
        laneLabel('docs'),
        queueOrderLabel(1),
        queueOrderLabel(2),
        queueOrderLabel(3),
      ]),
    );
    expect(await queue.list('daw')).toEqual([1055, 993, 1056]);
  });

  it('uses the canonical GitHub lane label when local lane spellings collide', async () => {
    const { client, state } = createFakeStore([
      { number: 1055, labels: [] },
      { number: 993, labels: [] },
    ]);
    const queue = createGithubQueue({ client, owner: 'o', repo: 'r', claimantId: 'aaa-1' });

    await queue.migrateLocalQueue([
      { lane: 'DAW', issue: 1055, lineNo: 1 },
      { lane: 'daw', issue: 993, lineNo: 2 },
    ]);

    expect(state.get(1055)).toEqual(new Set([QUEUED_LABEL, laneLabel('daw'), queueOrderLabel(1)]));
    expect(state.get(993)).toEqual(new Set([QUEUED_LABEL, laneLabel('daw'), queueOrderLabel(2)]));
  });
});

describe('claimNext', () => {
  it('claims the explicitly first candidate even when its issue number is higher', async () => {
    const { client, state } = createFakeStore([
      { number: 1055, labels: [QUEUED_LABEL, laneLabel('build'), queueOrderLabel(1)] },
      { number: 993, labels: [QUEUED_LABEL, laneLabel('build'), queueOrderLabel(2)] },
    ]);
    const queue = createGithubQueue({ client, owner: 'o', repo: 'r', claimantId: 'aaa-1' });

    const claimed = await queue.claimNext('build');

    expect(claimed).toEqual({ issue: 1055, decision: { kind: 'build' } });
    const labels = state.get(1055);
    expect(labels?.has(IN_PROGRESS_LABEL)).toBe(true);
    expect(labels?.has(claimedByLabel('aaa-1'))).toBe(true);
    expect(labels?.has(QUEUED_LABEL)).toBe(false);
  });

  it('creates every taxonomy label on first claim and memoises on the next claim for the same lane', async () => {
    const { client, createdLabels, calls } = createFakeStore([
      { number: 1, labels: [QUEUED_LABEL, laneLabel('build'), queueOrderLabel(1)] },
      { number: 2, labels: [QUEUED_LABEL, laneLabel('build'), queueOrderLabel(2)] },
    ]);
    const queue = createGithubQueue({ client, owner: 'o', repo: 'r', claimantId: 'aaa-1' });

    await queue.claimNext('build');
    const specs = queueLabelSpecs('build', 'aaa-1');
    for (const spec of specs) {
      expect(createdLabels.has(spec.name)).toBe(true);
    }
    const ensureCallsAfterFirst = calls.filter((c) => c === 'ensureLabel').length;
    expect(ensureCallsAfterFirst).toBe(specs.length);

    await queue.claimNext('build');
    expect(calls.filter((c) => c === 'ensureLabel').length).toBe(ensureCallsAfterFirst);
  });

  it('skips a candidate already in progress and claims the next one', async () => {
    const { client, state } = createFakeStore([
      { number: 1, labels: [QUEUED_LABEL, laneLabel('build'), queueOrderLabel(1), IN_PROGRESS_LABEL] },
      { number: 2, labels: [QUEUED_LABEL, laneLabel('build'), queueOrderLabel(2)] },
    ]);
    const queue = createGithubQueue({ client, owner: 'o', repo: 'r', claimantId: 'aaa-1' });

    const claimed = await queue.claimNext('build');

    expect(claimed).toEqual({ issue: 2, decision: { kind: 'build' } });
    expect(state.get(1)?.has(claimedByLabel('aaa-1'))).toBe(false);
  });

  it('returns null when there are no queued issues for the lane', async () => {
    const { client } = createFakeStore([{ number: 1, labels: [QUEUED_LABEL, laneLabel('other')] }]);
    const queue = createGithubQueue({ client, owner: 'o', repo: 'r', claimantId: 'aaa-1' });

    expect(await queue.claimNext('build')).toBeNull();
  });

  it('returns null when the only candidate is lost to another claimant', async () => {
    const { client } = createFakeStore([{ number: 1, labels: [QUEUED_LABEL, laneLabel('build'), queueOrderLabel(1)] }]);
    const wrapped: QueueGitHubClient = {
      ...client,
      async getIssueLabels(input) {
        const labels = await client.getIssueLabels(input);
        // Simulate a smaller-sorting claimant having also landed its label.
        return [...labels, 'factory:claimed-by:aaa-0'];
      },
    };
    const queue = createGithubQueue({ client: wrapped, owner: 'o', repo: 'r', claimantId: 'zzz-1' });

    expect(await queue.claimNext('build')).toBeNull();
  });

  it('advances to the next candidate without removing when its own claim label is absent from the read-back', async () => {
    const { client } = createFakeStore([
      { number: 1, labels: [QUEUED_LABEL, laneLabel('build'), queueOrderLabel(1)] },
      { number: 2, labels: [QUEUED_LABEL, laneLabel('build'), queueOrderLabel(2)] },
    ]);
    let getIssueLabelsCalls = 0;
    const removedNames: string[] = [];
    const wrapped: QueueGitHubClient = {
      ...client,
      async getIssueLabels(input) {
        getIssueLabelsCalls += 1;
        // A concurrent release stripped our own claim label before we could read it back.
        if (getIssueLabelsCalls === 1) return [];
        return client.getIssueLabels(input);
      },
      async removeLabel(input) {
        removedNames.push(input.name);
        return client.removeLabel(input);
      },
    };
    const queue = createGithubQueue({ client: wrapped, owner: 'o', repo: 'r', claimantId: 'aaa-1' });

    const claimed = await queue.claimNext('build');

    expect(claimed).toEqual({ issue: 2, decision: { kind: 'build' } });
    expect(removedNames).not.toContain(claimedByLabel('aaa-1'));
  });

  it('runs preflight before mutating candidate claim labels', async () => {
    const { client, calls } = createFakeStore([
      { number: 1, labels: [QUEUED_LABEL, laneLabel('build'), queueOrderLabel(1)] },
    ]);
    const queue = createGithubQueue({
      client,
      owner: 'o',
      repo: 'r',
      claimantId: 'aaa-1',
      preflight: async () => {
        expect(calls).not.toContain('addLabels');
        return { kind: 'build' };
      },
    });

    await queue.claimNext('build');

    expect(calls.indexOf('addLabels')).toBeGreaterThan(calls.indexOf('listOpenIssuesWithLabels'));
  });

  it('holds deferred work out for this queue instance without retrying or claiming it', async () => {
    const { client, state } = createFakeStore([
      { number: 1, labels: [QUEUED_LABEL, laneLabel('build'), queueOrderLabel(1)] },
      { number: 2, labels: [QUEUED_LABEL, laneLabel('build'), queueOrderLabel(2)] },
    ]);
    const preflightCalls: number[] = [];
    const queue = createGithubQueue({
      client,
      owner: 'o',
      repo: 'r',
      claimantId: 'aaa-1',
      preflight: async (candidate) => {
        preflightCalls.push(candidate.number);
        return candidate.number === 1 ? { kind: 'defer' } : { kind: 'build' };
      },
    });

    expect(await queue.claimNext('build')).toEqual({ issue: 2, decision: { kind: 'build' } });
    expect(await queue.claimNext('build')).toBeNull();
    expect(preflightCalls).toEqual([1, 2]);
    expect(state.get(1)).toEqual(new Set([QUEUED_LABEL, laneLabel('build'), queueOrderLabel(1)]));
  });

  it('keeps an adopt decision in the CAS-verified claim record', async () => {
    const { client } = createFakeStore([{ number: 1, labels: [QUEUED_LABEL, laneLabel('build'), queueOrderLabel(1)] }]);
    const queue = createGithubQueue({
      client,
      owner: 'o',
      repo: 'r',
      claimantId: 'aaa-1',
      preflight: async () => ({ kind: 'adopt', branch: 'contributor/finished-work' }),
    });

    expect(await queue.claimNext('build')).toEqual({
      issue: 1,
      decision: { kind: 'adopt', branch: 'contributor/finished-work' },
    });
  });

  it('does not remove another claimant when a parked decision loses the CAS', async () => {
    const { client, state } = createFakeStore([
      { number: 1, labels: [QUEUED_LABEL, laneLabel('build'), queueOrderLabel(1)] },
    ]);
    let readCount = 0;
    const wrapped: QueueGitHubClient = {
      ...client,
      async getIssueLabels(input) {
        readCount += 1;
        const labels = state.get(input.issue_number)!;
        if (readCount === 2) {
          labels.add(claimedByLabel('aaa-0'));
        }
        return client.getIssueLabels(input);
      },
    };
    const queue = createGithubQueue({
      client: wrapped,
      owner: 'o',
      repo: 'r',
      claimantId: 'zzz-1',
      preflight: async () => ({ kind: 'park', reason: 'CI verdict unavailable' }),
    });

    expect(await queue.claimNext('build')).toBeNull();
    expect(state.get(1)).toEqual(
      new Set([QUEUED_LABEL, laneLabel('build'), queueOrderLabel(1), IN_PROGRESS_LABEL, claimedByLabel('aaa-0')]),
    );
  });

  it('rechecks eligibility after preflight before claiming', async () => {
    const { client, state } = createFakeStore([
      { number: 1, labels: [QUEUED_LABEL, laneLabel('build'), queueOrderLabel(1)] },
    ]);
    const queue = createGithubQueue({
      client,
      owner: 'o',
      repo: 'r',
      claimantId: 'zzz-1',
      preflight: async () => {
        state.get(1)?.add(IN_PROGRESS_LABEL);
        state.get(1)?.add(claimedByLabel('aaa-0'));
        return { kind: 'build' };
      },
    });

    expect(await queue.claimNext('build')).toBeNull();
    expect(state.get(1)).toEqual(
      new Set([QUEUED_LABEL, laneLabel('build'), queueOrderLabel(1), IN_PROGRESS_LABEL, claimedByLabel('aaa-0')]),
    );
  });
});

describe('simulated concurrent claimNext (race)', () => {
  it('never lets two concurrent claimants win the same issue — the lexicographically smallest claim wins', async () => {
    const { client, state } = createFakeStore([
      { number: 1, labels: [QUEUED_LABEL, laneLabel('build'), queueOrderLabel(1)] },
      { number: 2, labels: [QUEUED_LABEL, laneLabel('build'), queueOrderLabel(2)] },
    ]);
    const queueA = createGithubQueue({ client, owner: 'o', repo: 'r', claimantId: 'aaa-1' });
    const queueB = createGithubQueue({ client, owner: 'o', repo: 'r', claimantId: 'zzz-2' });

    const [resultA, resultB] = await Promise.all([queueA.claimNext('build'), queueB.claimNext('build')]);

    expect(resultA).not.toBe(resultB);
    expect(resultA).toEqual({ issue: 1, decision: { kind: 'build' } });
    expect([2, null]).toContain(resultB?.issue ?? null);
    const claimsOnOne = [...(state.get(1) ?? [])].filter((l) => l.startsWith(CLAIMED_BY_LABEL_PREFIX));
    expect(claimsOnOne).toEqual([claimedByLabel('aaa-1')]);
  });

  it('exactly one caller wins when a single issue is contended by two claimants', async () => {
    const { client, state } = createFakeStore([
      { number: 1, labels: [QUEUED_LABEL, laneLabel('build'), queueOrderLabel(1)] },
    ]);
    const queueA = createGithubQueue({ client, owner: 'o', repo: 'r', claimantId: 'aaa-1' });
    const queueB = createGithubQueue({ client, owner: 'o', repo: 'r', claimantId: 'zzz-2' });

    const [resultA, resultB] = await Promise.all([queueA.claimNext('build'), queueB.claimNext('build')]);

    expect(resultA).toEqual({ issue: 1, decision: { kind: 'build' } });
    expect(resultB).toBeNull();
    const claimsOnOne = [...(state.get(1) ?? [])].filter((l) => l.startsWith(CLAIMED_BY_LABEL_PREFIX));
    expect(claimsOnOne).toEqual([claimedByLabel('aaa-1')]);
  });
});

describe('release', () => {
  it('restores factory:queued after a claim, and the issue becomes claimable again', async () => {
    const { client, state } = createFakeStore([
      { number: 1, labels: [QUEUED_LABEL, laneLabel('build'), queueOrderLabel(1)] },
    ]);
    const queue = createGithubQueue({ client, owner: 'o', repo: 'r', claimantId: 'aaa-1' });
    await queue.claimNext('build');

    await queue.release(1);

    const labels = state.get(1) ?? new Set<string>();
    expect(labels.has(QUEUED_LABEL)).toBe(true);
    expect(labels.has(queueOrderLabel(1))).toBe(true);
    expect(labels.has(IN_PROGRESS_LABEL)).toBe(false);
    expect([...labels].some((l) => l.startsWith(CLAIMED_BY_LABEL_PREFIX))).toBe(false);

    expect(await queue.claimNext('build')).toEqual({ issue: 1, decision: { kind: 'build' } });
  });

  it("release(issue, 'parked') leaves factory:parked and removes queued/in-progress/claim labels", async () => {
    const { client, state } = createFakeStore([
      { number: 1, labels: [QUEUED_LABEL, laneLabel('build'), queueOrderLabel(1)] },
    ]);
    const queue = createGithubQueue({ client, owner: 'o', repo: 'r', claimantId: 'aaa-1' });
    await queue.claimNext('build');

    await queue.release(1, 'parked');

    const labels = state.get(1) ?? new Set<string>();
    expect(labels.has(PARKED_LABEL)).toBe(true);
    expect(labels.has(QUEUED_LABEL)).toBe(false);
    expect(labels.has(queueOrderLabel(1))).toBe(false);
    expect(labels.has(IN_PROGRESS_LABEL)).toBe(false);
    expect([...labels].some((l) => l.startsWith(CLAIMED_BY_LABEL_PREFIX))).toBe(false);

    expect(await queue.claimNext('build')).toBeNull();
  });

  it('never removes a label that is not present, and issues no redundant add', async () => {
    const { client, calls } = createFakeStore([{ number: 1, labels: [QUEUED_LABEL] }]);
    const queue = createGithubQueue({ client, owner: 'o', repo: 'r', claimantId: 'aaa-1' });

    await queue.release(1);

    expect(calls.filter((c) => c === 'removeLabel')).toEqual([]);
    expect(calls.filter((c) => c === 'addLabels')).toEqual([]);
  });

  it("release(issue, 'done') strips queue-state labels, keeps the lane label, and adds nothing", async () => {
    const { client, state, calls } = createFakeStore([
      {
        number: 1,
        labels: [QUEUED_LABEL, IN_PROGRESS_LABEL, claimedByLabel('aaa-1'), laneLabel('app'), queueOrderLabel(1)],
      },
    ]);
    const queue = createGithubQueue({ client, owner: 'o', repo: 'r', claimantId: 'aaa-1' });

    await queue.release(1, 'done');

    const labels = state.get(1) ?? new Set<string>();
    expect(labels.has(QUEUED_LABEL)).toBe(false);
    expect(labels.has(queueOrderLabel(1))).toBe(false);
    expect(labels.has(IN_PROGRESS_LABEL)).toBe(false);
    expect([...labels].some((l) => l.startsWith(CLAIMED_BY_LABEL_PREFIX))).toBe(false);
    expect(labels.has(laneLabel('app'))).toBe(true);
    expect(calls.filter((c) => c === 'addLabels')).toEqual([]);
  });

  it("release(issue, 'done') on an issue with no factory labels is a total no-op", async () => {
    const { client, state, calls } = createFakeStore([{ number: 1, labels: [] }]);
    const queue = createGithubQueue({ client, owner: 'o', repo: 'r', claimantId: 'aaa-1' });

    await queue.release(1, 'done');

    expect(state.get(1)).toEqual(new Set());
    expect(calls.filter((c) => c === 'removeLabel')).toEqual([]);
    expect(calls.filter((c) => c === 'addLabels')).toEqual([]);
  });
});

describe('enqueue', () => {
  it("appends after the lane's current max order position", async () => {
    const { client, state, createdLabels } = createFakeStore([
      { number: 5, labels: [QUEUED_LABEL, laneLabel('daw'), queueOrderLabel(2)] },
    ]);
    const queue = createGithubQueue({ client, owner: 'o', repo: 'r', claimantId: 'aaa-1' });

    const results = await queue.enqueue('daw', [10, 11]);

    expect(results).toEqual([
      { issue: 10, outcome: 'queued', position: 3 },
      { issue: 11, outcome: 'queued', position: 4 },
    ]);
    expect(state.get(10)).toEqual(new Set([QUEUED_LABEL, laneLabel('daw'), queueOrderLabel(3)]));
    expect(state.get(11)).toEqual(new Set([QUEUED_LABEL, laneLabel('daw'), queueOrderLabel(4)]));
    expect(createdLabels).toEqual(new Set([QUEUED_LABEL, laneLabel('daw'), queueOrderLabel(3), queueOrderLabel(4)]));
  });

  it('starts at position 1 for an empty lane', async () => {
    const { client } = createFakeStore([{ number: 5, labels: [] }]);
    const queue = createGithubQueue({ client, owner: 'o', repo: 'r', claimantId: 'aaa-1' });

    const results = await queue.enqueue('docs', [5]);

    expect(results).toEqual([{ issue: 5, outcome: 'queued', position: 1 }]);
  });

  it('skips an already-ordered issue and leaves its labels unchanged', async () => {
    const { client, state } = createFakeStore([
      { number: 7, labels: [QUEUED_LABEL, laneLabel('daw'), queueOrderLabel(1)] },
    ]);
    const queue = createGithubQueue({ client, owner: 'o', repo: 'r', claimantId: 'aaa-1' });

    const results = await queue.enqueue('daw', [7]);

    expect(results).toEqual([{ issue: 7, outcome: 'already-queued' }]);
    expect(state.get(7)).toEqual(new Set([QUEUED_LABEL, laneLabel('daw'), queueOrderLabel(1)]));
  });

  it('creates every label via ensureLabel before applying it with addLabels', async () => {
    const { client, calls } = createFakeStore([{ number: 1, labels: [] }]);
    const queue = createGithubQueue({ client, owner: 'o', repo: 'r', claimantId: 'aaa-1' });

    await queue.enqueue('daw', [1]);

    expect(calls.indexOf('ensureLabel')).toBeLessThan(calls.indexOf('addLabels'));
  });

  it('isolates a per-issue failure without aborting the rest of the batch', async () => {
    const { client, state } = createFakeStore([
      { number: 99, labels: [] },
      { number: 100, labels: [] },
    ]);
    const wrapped: QueueGitHubClient = {
      ...client,
      async addLabels(input) {
        if (input.issue_number === 99) throw new Error('boom');
        return client.addLabels(input);
      },
    };
    const queue = createGithubQueue({ client: wrapped, owner: 'o', repo: 'r', claimantId: 'aaa-1' });

    const results = await queue.enqueue('daw', [99, 100]);

    expect(results).toEqual([
      { issue: 99, outcome: 'failed', detail: 'boom' },
      { issue: 100, outcome: 'queued', position: 1 },
    ]);
    expect(state.get(100)).toEqual(new Set([QUEUED_LABEL, laneLabel('daw'), queueOrderLabel(1)]));
  });
});

describe('lanes', () => {
  it('returns sorted distinct lane slugs from queued issues', async () => {
    const { client } = createFakeStore([
      { number: 1, labels: [QUEUED_LABEL, laneLabel('infra')] },
      { number: 2, labels: [QUEUED_LABEL, laneLabel('app')] },
      { number: 3, labels: [QUEUED_LABEL, laneLabel('app')] },
    ]);
    const queue = createGithubQueue({ client, owner: 'o', repo: 'r', claimantId: 'aaa-1' });

    expect(await queue.lanes()).toEqual(['app', 'infra']);
  });

  it('omits a queued issue that carries no lane label', async () => {
    const { client } = createFakeStore([
      { number: 1, labels: [QUEUED_LABEL] },
      { number: 2, labels: [QUEUED_LABEL, laneLabel('app')] },
    ]);
    const queue = createGithubQueue({ client, owner: 'o', repo: 'r', claimantId: 'aaa-1' });

    expect(await queue.lanes()).toEqual(['app']);
  });

  it('returns an empty array when nothing is queued', async () => {
    const { client } = createFakeStore([]);
    const queue = createGithubQueue({ client, owner: 'o', repo: 'r', claimantId: 'aaa-1' });

    expect(await queue.lanes()).toEqual([]);
  });
});

describe('createOctokitQueueClient', () => {
  it('lists open issues with the given labels, dropping pull requests and normalising label shapes', async () => {
    const octokit: any = {
      rest: {
        issues: {
          listForRepo: async (input: unknown) => {
            captured.listForRepo = input;
            return {
              data: [
                { number: 1, labels: ['factory:queued', { name: 'factory:lane:build' }] },
                { number: 2, labels: [{ name: '' }, { name: undefined }], pull_request: {} },
              ],
            };
          },
        },
      },
    };
    const captured: Record<string, unknown> = {};

    const client = createOctokitQueueClient(octokit);
    const result = await client.listOpenIssuesWithLabels({ owner: 'o', repo: 'r', labels: ['factory:queued'] });

    expect(captured.listForRepo).toEqual({
      owner: 'o',
      repo: 'r',
      state: 'open',
      labels: 'factory:queued',
      per_page: 100,
    });
    expect(result).toEqual([{ number: 1, labels: ['factory:queued', 'factory:lane:build'] }]);
  });

  it("reads back an issue's current label names", async () => {
    const octokit: any = {
      rest: {
        issues: {
          listLabelsOnIssue: async (input: { issue_number: number }) => {
            expect(input.issue_number).toBe(9);
            return { data: [{ name: 'factory:queued' }, { name: 'factory:in-progress' }] };
          },
        },
      },
    };

    const client = createOctokitQueueClient(octokit);
    const labels = await client.getIssueLabels({ owner: 'o', repo: 'r', issue_number: 9 });

    expect(labels).toEqual(['factory:queued', 'factory:in-progress']);
  });

  it('adds labels through octokit.rest.issues.addLabels', async () => {
    let captured: unknown;
    const octokit: any = {
      rest: {
        issues: {
          addLabels: async (input: unknown) => {
            captured = input;
          },
        },
      },
    };

    const client = createOctokitQueueClient(octokit);
    await client.addLabels({ owner: 'o', repo: 'r', issue_number: 3, labels: ['factory:in-progress'] });

    expect(captured).toEqual({ owner: 'o', repo: 'r', issue_number: 3, labels: ['factory:in-progress'] });
  });

  it('removes a label through octokit.rest.issues.removeLabel', async () => {
    let captured: unknown;
    const octokit: any = {
      rest: {
        issues: {
          removeLabel: async (input: unknown) => {
            captured = input;
          },
        },
      },
    };

    const client = createOctokitQueueClient(octokit);
    await client.removeLabel({ owner: 'o', repo: 'r', issue_number: 3, name: 'factory:queued' });

    expect(captured).toEqual({ owner: 'o', repo: 'r', issue_number: 3, name: 'factory:queued' });
  });

  it('ensureLabel creates the label when missing', async () => {
    let captured: unknown;
    const octokit: any = {
      rest: {
        issues: {
          createLabel: async (input: unknown) => {
            captured = input;
          },
        },
      },
    };

    const client = createOctokitQueueClient(octokit);
    await client.ensureLabel({ owner: 'o', repo: 'r', name: 'factory:queued', color: '0e8a16', description: 'desc' });

    expect(captured).toEqual({ owner: 'o', repo: 'r', name: 'factory:queued', color: '0e8a16', description: 'desc' });
  });

  it('ensureLabel swallows an already-exists (422) error', async () => {
    const octokit: any = {
      rest: {
        issues: {
          createLabel: async () => {
            throw { status: 422 };
          },
        },
      },
    };

    const client = createOctokitQueueClient(octokit);

    await expect(
      client.ensureLabel({ owner: 'o', repo: 'r', name: 'factory:queued', color: '0e8a16', description: 'desc' }),
    ).resolves.toBeUndefined();
  });

  it('ensureLabel rethrows a non-422 error', async () => {
    const octokit: any = {
      rest: {
        issues: {
          createLabel: async () => {
            throw { status: 500 };
          },
        },
      },
    };

    const client = createOctokitQueueClient(octokit);

    await expect(
      client.ensureLabel({ owner: 'o', repo: 'r', name: 'factory:queued', color: '0e8a16', description: 'desc' }),
    ).rejects.toEqual({ status: 500 });
  });
});
