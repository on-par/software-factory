import { parseDecompositionOutput, withSliceState } from '@on-par/factory-core/internal';
import type { SlicePlan } from '@on-par/factory-core/internal';
import { describe, expect, it, vi } from 'vitest';

import type { QueuePreflightOps, SlicePullState } from './index.js';
import { waitForMerge } from './land.js';
import { preflightQueuedIssue } from './index.js';
import { runLane } from './run-lane.js';

const story = (n: number) => ({
  title: `Story ${n}`,
  role: 'operator',
  want: `thing ${n} works`,
  soThat: 'value',
  problemStatement: `Problem ${n}`,
  inScope: [`scope ${n}`],
  outOfScope: ['other'],
  acceptanceCriteria: [{ name: `ac ${n}`, given: [], when: ['run'], then: ['works'] }],
  verification: [{ command: 'npm test', passWhen: 'passes' }],
  tracesTo: ['INT-PROBLEM-01'],
});

const stackPlan = (): SlicePlan => {
  const stories = [1, 2, 3].map(story);
  const parsed = parseDecompositionOutput(
    JSON.stringify({
      epic: { title: 'Epic', why: 'why', doneWhen: ['done'], children: stories.map((s) => s.title) },
      stories,
    }),
  );
  if (!parsed.ok) throw new Error(parsed.reason);
  let plan: SlicePlan = {
    issue: 7,
    slices: parsed.decomposition.stories.map((st, i) => ({
      index: i + 1,
      title: st.title,
      story: st,
      state: 'pending' as const,
    })),
  };
  plan = withSliceState(plan, 1, 'pr-open', 11);
  plan = withSliceState(plan, 2, 'pr-open', 12);
  return withSliceState(plan, 3, 'pr-open', 13);
};

const makeOps = (
  states: Record<number, SlicePullState>,
  over: Partial<QueuePreflightOps> = {},
  watchResult: 'success' | 'failure' | 'timeout' = 'success',
) => {
  const log: string[] = [];
  const saved: SlicePlan[] = [];
  const ops = {
    expectedHeadRepoFullName: 'on-par/software-factory',
    findOpenPR: async () => (
      log.push('findOpenPR'),
      { number: 13, branch: 'factory/7-s3-x', headSha: 'top', headRepoFullName: 'on-par/software-factory' }
    ),
    getLandState: async () => (log.push('getLandState'), { isDraft: true, mergeStateStatus: 'CLEAN' }),
    watch: async (sha: string) => (log.push(`watch ${sha}`), watchResult),
    findSlicePlan: vi.fn(async () => ({ status: 'found' as const, commentId: 5, plan: stackPlan() })),
    getPullState: vi.fn(async (pr: number) => states[pr]),
    saveSlicePlan: async (_issue: number, plan: SlicePlan) => void saved.push(plan),
    autoMergeStack: false,
    stackMode: false,
    getPullReviews: vi.fn(async () => {
      throw new Error('unexpected review lookup');
    }),
    readIssueBody: vi.fn(async () => ''),
    getMergedClosingPr: vi.fn(async () => undefined),
    getPrerequisiteState: vi.fn(async () => {
      throw new Error('unexpected prerequisite lookup');
    }),
    getPullRefs: vi.fn(async () => ({ headRef: 'factory/7-s2-x', baseRef: 'main', headSha: 'rebased' })),
    branchContains: vi.fn(async () => false),
    ...over,
  };
  return { ...(ops satisfies QueuePreflightOps), log, saved };
};

const issue = { number: 7, labels: [] };

describe('stack queue preflight and merge ordering (ADR-0161)', () => {
  it("preflight defers a stack whose bottom layer merged instead of falling through to the top layer's Closes PR", async () => {
    const ops = makeOps({ 11: 'merged', 12: 'open', 13: 'open' });
    await expect(preflightQueuedIssue(issue, ops)).resolves.toEqual({ kind: 'defer' });
    expect(ops.log).toEqual([]);
    expect(ops.saved).toHaveLength(1);
    expect(ops.saved[0].slices.map((s) => s.state)).toEqual(['merged', 'pr-open', 'pr-open']);
  });

  it('preflight defers while the bottom layer is still open and never consults the Closes PR', async () => {
    const ops = makeOps({ 11: 'open', 12: 'open', 13: 'open' });
    await expect(preflightQueuedIssue(issue, ops)).resolves.toEqual({ kind: 'defer' });
    expect(ops.saved).toEqual([]);
    expect(ops.log).not.toContain('findOpenPR');
  });

  it('after the bottom layer merges, preflight records slice 1 merged and adopts slice 2 once its base is main', async () => {
    const ops = makeOps({ 11: 'merged', 12: 'open', 13: 'open' }, { autoMergeStack: true });
    await expect(preflightQueuedIssue(issue, ops)).resolves.toEqual({
      kind: 'adopt',
      branch: 'factory/7-s2-x',
      stackLayer: { index: 2, count: 3, prNumber: 12 },
    });
    expect(ops.log).toContain('watch rebased');
    expect(ops.saved[0].slices[0].state).toBe('merged');
  });

  describe('preflight does not adopt a stack layer whose rebased head CI is not green', () => {
    const states = { 11: 'merged', 12: 'open', 13: 'open' } as const;

    it('defers without watching CI while the base is still the lower branch', async () => {
      const ops = makeOps(states, {
        autoMergeStack: true,
        getPullRefs: async () => ({ headRef: 'factory/7-s2-x', baseRef: 'factory/7-x', headSha: 'old' }),
      });
      const decision = await preflightQueuedIssue(issue, ops);
      expect(decision).toEqual({ kind: 'defer' });
      expect(ops.log).toEqual([]);
    });

    it('parks when CI failed on the rebased head', async () => {
      const ops = makeOps(states, { autoMergeStack: true }, 'failure');
      const decision = await preflightQueuedIssue(issue, ops);
      expect(decision.kind).toBe('park');
      expect(decision.kind === 'park' && decision.reason).toMatch(/CI for slice 2\/3 PR #12 ended failure/);
      expect(ops.log).not.toContain('findOpenPR');
    });

    it('defers when CI timed out', async () => {
      const ops = makeOps(states, { autoMergeStack: true }, 'timeout');
      const decision = await preflightQueuedIssue(issue, ops);
      expect(decision).toEqual({ kind: 'defer' });
      expect(ops.log).not.toContain('findOpenPR');
    });
  });

  it('a closed lower layer parks and names the layers above it', async () => {
    const ops = makeOps({ 11: 'closed', 12: 'open', 13: 'open' });
    const decision = await preflightQueuedIssue(issue, ops);
    expect(decision.kind).toBe('park');
    const reason = decision.kind === 'park' ? decision.reason : '';
    expect(reason).toContain('slice 1/3 PR #11 was closed without merging');
    expect(reason).toContain('slice 2/3 (#12), slice 3/3 (#13)');
  });

  describe('runLane stack layer', () => {
    const paths: any = { events: '/repo/.factory/events.ndjson', stop: '/repo/.factory/STOP' };
    const run = async (index: number) => {
      const claims = [
        {
          issue: 7,
          decision: {
            kind: 'adopt' as const,
            branch: 'factory/7-s2-x',
            stackLayer: { index, count: 3, prNumber: 12 },
          },
        },
      ];
      const waits: unknown[][] = [];
      const merges: unknown[][] = [];
      const releases: unknown[][] = [];
      await runLane('app', [], '/repo', 'on-par/software-factory', paths, {
        claimNext: async () => claims.shift() ?? null,
        ship: async () => {
          throw new Error('shipIssue must not run for an adopted PR');
        },
        waitMerge: async (...a) => void waits.push(a),
        recordStackMerge: async (...a) => void merges.push(a),
        releaseIssue: async (...a) => void releases.push(a),
        pathExists: () => false,
        emitEvent: () => {},
      });
      return { waits, merges, releases };
    };

    it('lands an adopted stack layer by its branch, records it merged and re-queues the issue', async () => {
      const { waits, merges, releases } = await run(2);
      expect(waits).toEqual([
        [
          7,
          'factory/7-s2-x',
          '/repo',
          'on-par/software-factory',
          paths,
          { landBranch: 'factory/7-s2-x', signal: expect.any(AbortSignal) },
        ],
      ]);
      expect(merges).toEqual([[7, 12]]);
      expect(releases).toEqual([[7, 'queued']]);
    });

    it('settles done for the top layer', async () => {
      const { releases } = await run(3);
      expect(releases).toEqual([[7, 'done']]);
    });
  });

  it('waitForMerge lands the exact stack branch', async () => {
    const landCalls: unknown[][] = [];
    const land = (async (...a: unknown[]) => (landCalls.push(a), { branch: 'factory/7-s2-x', prNumber: 12 })) as never;
    const checkMerged = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const paths: any = { events: '/repo/events.ndjson', stop: '/repo/STOP' };
    await waitForMerge(7, 'factory/7-s2-x', '/repo', 'on-par/software-factory', paths, {
      createOctokit: () => ({}) as any,
      pathExists: () => false,
      checkMerged,
      loadConfig: () =>
        ({
          merge: { auto: true, comment: '' },
          ci: { skip: false, comment: '' },
          filing: { enabled: true, excludeReasons: [], repeatThreshold: 3, maxPerRun: 5, maxPerDay: 20 },
        }) as any,
      listIssueLabels: async () => [],
      mergeEnabled: () => true,
      land,
      landBranch: 'factory/7-s2-x',
      emitEvent: () => {},
      sleep: async () => {},
    });
    expect(landCalls).toHaveLength(1);
    expect(landCalls[0][7]).toEqual({ branch: 'factory/7-s2-x', enforceRisk: true });
  });
});
