// packages/cli/src/cli/run-restack.test.ts — the lane's restack hook reads the trusted slice plan (#3368)
import type { Octokit } from '@octokit/rest';
import { parseDecompositionOutput, renderSlicePlanComment, type SlicePlan } from '@on-par/factory-core/internal';
import { fakeOctokit } from '@on-par/factory-core/testing';
import { describe, expect, it, vi } from 'vitest';

import { restackFromSlicePlan } from './run-restack.js';

const BOT = 42;

function plan(issue: number): SlicePlan {
  const story = {
    title: 'Story 1',
    role: 'operator',
    want: 'it works',
    soThat: 'value',
    problemStatement: 'Problem',
    inScope: ['scope'],
    outOfScope: ['other'],
    acceptanceCriteria: [{ name: 'ac', given: [], when: ['run'], then: ['works'] }],
    verification: [{ command: 'npm test', passWhen: 'passes' }],
    tracesTo: ['INT-PROBLEM-01'],
  };
  const parsed = parseDecompositionOutput(
    JSON.stringify({
      epic: { title: 'Epic', why: 'why', doneWhen: ['done'], children: [story.title] },
      stories: [story],
    }),
  );
  if (!parsed.ok) throw new Error(parsed.reason);
  const [only] = parsed.decomposition.stories;
  return { issue, slices: [{ index: 1, title: only!.title, story: only!, state: 'pending' }] };
}

function octokitFixture(bodies: string[]) {
  const updateComment = vi.fn(async () => ({ data: {} }));
  const { octokit } = fakeOctokit({
    'users.getAuthenticated': async () => ({ data: { id: BOT } }),
    'issues.listComments': async ({ page }: { page: number }) => ({
      data: page === 1 ? bodies.map((body, i) => ({ id: 500 + i, user: { id: BOT }, body })) : [],
    }),
    'issues.updateComment': updateComment,
    'issues.createComment': vi.fn(async () => ({ data: { id: 1 } })),
  });
  return { octokit: octokit as Octokit, updateComment };
}

const base = { repo: 'o/r', repoRoot: '/repo', issue: 7, merged: { index: 1, prNumber: 81 } };

describe('restackFromSlicePlan', () => {
  it('does nothing when the issue has no slice plan', async () => {
    const restack = vi.fn();
    const out = await restackFromSlicePlan({ ...base, octokit: octokitFixture([]).octokit, restack });
    expect(out).toEqual({ status: 'nothing', reason: 'no slice plan to restack' });
    expect(restack).not.toHaveBeenCalled();
  });

  it('parks when the slice plan comment is unreadable', async () => {
    const restack = vi.fn();
    const { octokit } = octokitFixture([renderSlicePlanComment(plan(8))]);
    const out = await restackFromSlicePlan({ ...base, octokit, restack });
    expect(out).toEqual({ status: 'park', reason: 'slice plan unavailable for restack', index: 1, files: [] });
    expect(restack).not.toHaveBeenCalled();
  });

  it('restacks with the trusted plan and saves new head SHAs back to the slice plan comment', async () => {
    const trusted = plan(7);
    const { octokit, updateComment } = octokitFixture([renderSlicePlanComment(trusted)]);
    const restack = vi.fn(
      async (opts: Parameters<NonNullable<Parameters<typeof restackFromSlicePlan>[0]['restack']>>[0]) => {
        await opts.savePlan(opts.plan);
        return { status: 'nothing' as const, reason: 'stub' };
      },
    );
    const out = await restackFromSlicePlan({ ...base, octokit, restack });
    expect(out).toEqual({ status: 'nothing', reason: 'stub' });
    expect(restack).toHaveBeenCalledWith(
      expect.objectContaining({ repoRoot: '/repo', repo: 'o/r', plan: trusted, mergedIndex: 1, mergedPrNumber: 81 }),
    );
    expect(updateComment).toHaveBeenCalledWith(expect.objectContaining({ comment_id: 500 }));
  });
});
