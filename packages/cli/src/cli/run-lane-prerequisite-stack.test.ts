// packages/cli/src/cli/run-lane-prerequisite-stack.test.ts — runLane builds, restacks and holds stacked issues (#3916).

import { describe, expect, it } from 'vitest';

import { runLane } from './run-lane.js';

const paths: any = { events: '/repo/.factory/events.ndjson', stop: '/repo/.factory/STOP' };
const prereq = { issue: 5, prNumber: 50, branch: 'factory/5-prereq', headSha: 'b'.repeat(40) };

async function run(claims: any[], extra: any = {}) {
  const calls: any[] = [];
  await runLane('app', [], '/repo', 'on-par/software-factory', paths, {
    claimNext: async () => claims.shift() ?? null,
    ship: async (issue: number, opts: any) => {
      calls.push(['ship', issue, opts]);
      return 'factory/6-x';
    },
    waitMerge: async () => {
      calls.push(['waitMerge']);
    },
    releaseIssue: async (issue: number, outcome: string) => {
      calls.push(['release', issue, outcome]);
    },
    pathExists: () => false,
    emitEvent: (_f: any, type: any, _i: any, msg: any) => calls.push(['event', type, msg]),
    ...extra,
  });
  return calls;
}

const restackDecision = {
  kind: 'restack-prerequisite' as const,
  prNumber: 60,
  branch: 'factory/6-x',
  recordedHead: 'x'.repeat(40),
  stackedOn: prereq,
  onto: { kind: 'main' as const, mergedHead: 'c'.repeat(40) },
};

describe('runLane cross-issue stacks (#3916)', () => {
  it('run-lane ships a stacked issue with the prerequisite branch as base', async () => {
    const calls = await run([{ issue: 6, decision: { kind: 'build', stackOn: prereq } }]);
    expect(calls).toContainEqual(['ship', 6, { baseBranch: 'factory/5-prereq', prerequisiteStack: prereq }]);
    expect(calls).toContainEqual(['release', 6, 'queued']);
    expect(calls.some((c) => c[0] === 'waitMerge')).toBe(false);
  });

  it('ships a plain build without a base branch', async () => {
    const calls = await run([{ issue: 6, decision: { kind: 'build' } }]);
    expect(calls).toContainEqual(['ship', 6, {}]);
    expect(calls).toContainEqual(['release', 6, 'done']);
  });

  it('restacks a stacked PR and re-queues the issue without shipping', async () => {
    const restackPrerequisite = async (d: any) => {
      expect(d).toBe(restackDecision);
      return { status: 'restacked' as const, headSha: 'n', retargeted: true };
    };
    const calls = await run([{ issue: 6, decision: restackDecision }], { restackPrerequisite });
    expect(calls).toContainEqual(['release', 6, 'queued']);
    expect(calls.some((c) => c[0] === 'ship')).toBe(false);
  });

  it('parks when the prerequisite restack parks or throws', async () => {
    const parked = await run([{ issue: 6, decision: restackDecision }], {
      restackPrerequisite: async () => ({ status: 'park', reason: 'conflicted in: a.ts', files: ['a.ts'] }),
    });
    expect(parked).toContainEqual(['release', 6, 'parked']);
    const thrown = await run([{ issue: 6, decision: restackDecision }], {
      restackPrerequisite: async () => {
        throw new Error('boom');
      },
    });
    expect(thrown).toContainEqual(['release', 6, 'parked']);
    const unwired = await run([{ issue: 6, decision: restackDecision }]);
    expect(unwired).toContainEqual(['release', 6, 'parked']);
  });

  it('parks a held issue with the reason naming the prerequisite PR', async () => {
    const reason = 'prerequisite PR #50 (issue #5) was closed without merging';
    const calls = await run([{ issue: 6, decision: { kind: 'held', reason, prerequisitePr: 50 } }]);
    expect(calls).toContainEqual(['release', 6, 'parked']);
    expect(calls).toContainEqual(['event', 'escalate', reason]);
    expect(calls.some((c) => c[0] === 'ship')).toBe(false);
  });
});
