// packages/cli/src/cli/run-lane-await-merge-stopped.test.ts — a STOP during await-merge re-queues the issue (#3291)

import { describe, expect, it } from 'vitest';

import { AwaitMergeStoppedError } from './land-pr.js';
import { runLane } from './run-lane.js';

describe('runLane STOP during await-merge', () => {
  const paths: any = { events: '/repo/.factory/events.ndjson', stop: '/repo/.factory/STOP' };

  it('a STOP during await-merge re-queues the issue instead of settling it as done (#3181, PR #3289)', async () => {
    const calls: any[] = [];
    await runLane('app', [7], '/repo', 'on-par/software-factory', paths, {
      ship: async () => 'ship-it/7-x',
      waitMerge: async (_issue, branch) => {
        throw new AwaitMergeStoppedError(`STOP during await-merge: PR #12 on ${branch} left open`, branch, 12);
      },
      releaseIssue: async (issue, outcome) => {
        calls.push(['release', issue, outcome]);
      },
      pathExists: () => false,
      emitEvent: (_events: string, type: string, issue: string | number, msg: string) =>
        calls.push(['event', type, issue, msg]),
    });

    expect(calls).toContainEqual(['release', 7, 'queued']);
    expect(calls).not.toContainEqual(['release', 7, 'done']);
    const stopped = calls.filter((c) => c[0] === 'event' && c[1] === 'await-merge-stopped' && c[2] === 7);
    expect(stopped).toHaveLength(1);
    expect(stopped[0][3]).toContain('PR #12');
    expect(stopped[0][3]).toContain('ship-it/7-x');
    expect(calls.find((c) => c[0] === 'event' && c[1] === 'lane-done')?.[3]).toContain('0 merged');
    expect(calls.some((c) => c[0] === 'event' && (c[1] === 'parked' || c[1] === 'escalate'))).toBe(false);
  });

  it('re-queues a stopped stack-layer wait without recording a merge or restacking', async () => {
    const calls: any[] = [];
    const claims = [
      {
        issue: 7,
        decision: {
          kind: 'adopt' as const,
          branch: 'factory/7-slice-1',
          stackLayer: { index: 1, count: 2, prNumber: 12 },
        },
      },
    ];
    await runLane('app', [], '/repo', 'on-par/software-factory', paths, {
      claimNext: async () => claims.shift() ?? null,
      ship: async () => {
        throw new Error('ship must not run for an adopted PR');
      },
      waitMerge: async (_issue, branch) => {
        throw new AwaitMergeStoppedError('STOP during await-merge', branch, 12);
      },
      recordStackMerge: async (issue, pr) => {
        calls.push(['recordStackMerge', issue, pr]);
      },
      restack: async () => {
        calls.push(['restack']);
        return { status: 'nothing', reason: 'unused' };
      },
      releaseIssue: async (issue, outcome) => {
        calls.push(['release', issue, outcome]);
      },
      pathExists: () => false,
      emitEvent: (_events: string, type: string, _issue: string | number, msg: string) =>
        calls.push(['event', type, msg]),
    });

    expect(calls.some((c) => c[0] === 'recordStackMerge' || c[0] === 'restack')).toBe(false);
    expect(calls).toContainEqual(['release', 7, 'queued']);
    expect(calls.find((c) => c[0] === 'event' && c[1] === 'lane-done')?.[2]).toContain('0 merged');
  });
});
