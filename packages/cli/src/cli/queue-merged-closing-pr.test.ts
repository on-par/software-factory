import { describe, expect, it } from 'vitest';

import { makeQueuePreflightOps } from './queue-preflight.js';

type Page = { nodes: unknown[]; hasNextPage?: boolean; endCursor?: string | null };

const page = (p: Page, defaultBranchRef: unknown = { name: 'main' }) => ({
  repository: {
    defaultBranchRef,
    issue: {
      closedByPullRequestsReferences: {
        nodes: p.nodes,
        pageInfo: { hasNextPage: p.hasNextPage ?? false, endCursor: p.endCursor ?? null },
      },
    },
  },
});

function opsFor(pages: unknown[], revertHits: unknown[] = []) {
  const calls: Array<{ query: string; vars: Record<string, unknown> }> = [];
  let at = 0;
  const octokit: any = {
    graphql: async (query: string, vars: Record<string, unknown>) => {
      calls.push({ query, vars });
      if (query.includes('QueueRevertSearch')) return { search: { nodes: revertHits } };
      return pages[at++];
    },
  };
  const ops = makeQueuePreflightOps(octokit, 'on-par', 'software-factory', {
    watch: async () => 'success' as const,
  });
  return { ops, calls };
}

describe('getMergedClosingPr (#3375)', () => {
  it('returns a merged default-branch closing PR and paginates', async () => {
    const { ops, calls } = opsFor([
      page({ nodes: [{ number: 899, merged: false, baseRefName: 'main' }], hasNextPage: true, endCursor: 'cursor-1' }),
      page({ nodes: [{ number: 900, merged: true, baseRefName: 'main' }] }),
    ]);
    await expect(ops.getMergedClosingPr(7)).resolves.toBe(900);
    expect(calls[1]?.vars).toMatchObject({ owner: 'on-par', repo: 'software-factory', number: 7, after: 'cursor-1' });
    expect(calls[2]?.vars.q).toContain('"Reverts on-par/software-factory#900"');
  });

  it.each([
    ['open', { number: 900, merged: false, baseRefName: 'main' }],
    ['closed unmerged', { number: 900, merged: false, baseRefName: 'main' }],
    ['non-default base', { number: 900, merged: true, baseRefName: 'develop' }],
  ])('ignores a %s closing PR', async (_name, node) => {
    const { ops } = opsFor([page({ nodes: [node] })]);
    await expect(ops.getMergedClosingPr(7)).resolves.toBeUndefined();
  });

  it('returns undefined with no closing PRs', async () => {
    const { ops } = opsFor([page({ nodes: [] })]);
    await expect(ops.getMergedClosingPr(7)).resolves.toBeUndefined();
  });

  it('ignores a closing PR reverted by a merged PR', async () => {
    const { ops } = opsFor(
      [page({ nodes: [{ number: 900, merged: true, baseRefName: 'main' }] })],
      [{ number: 950, merged: true, body: 'Reverts on-par/software-factory#900\n\ntext' }],
    );
    await expect(ops.getMergedClosingPr(7)).resolves.toBeUndefined();
  });

  it.each([
    ['an unmerged revert', { number: 950, merged: false, body: 'Reverts on-par/software-factory#900' }],
    ['a longer PR number', { number: 951, merged: true, body: 'Reverts on-par/software-factory#9001' }],
    ['another repo', { number: 952, merged: true, body: 'Reverts other/repo#900' }],
    ['a missing body', { number: 953, merged: true, body: null }],
  ])('still returns the PR when the only revert hit is %s', async (_name, hit) => {
    const { ops } = opsFor([page({ nodes: [{ number: 900, merged: true, baseRefName: 'main' }] })], [hit]);
    await expect(ops.getMergedClosingPr(7)).resolves.toBe(900);
  });

  it('falls through a reverted candidate to the next unreverted one', async () => {
    const { ops } = opsFor(
      [
        page({
          nodes: [
            { number: 900, merged: true, baseRefName: 'main' },
            { number: 901, merged: true, baseRefName: 'main' },
          ],
        }),
      ],
      [{ number: 950, merged: true, body: 'Reverts on-par/software-factory#900' }],
    );
    await expect(ops.getMergedClosingPr(7)).resolves.toBe(901);
  });

  it('rejects malformed evidence', async () => {
    const node: Record<string, unknown> = { number: 900, merged: true, baseRefName: 'main' };
    const cases: unknown[][] = [
      [null],
      [{ repository: { defaultBranchRef: { name: 'main' }, issue: null } }],
      [page({ nodes: [node] }, null)],
      [page({ nodes: [node] }, { name: '' })],
      [page({ nodes: [{ ...node, merged: 'yes' }] })],
      [page({ nodes: [{ ...node, number: '900' }] })],
      [page({ nodes: [{ ...node, baseRefName: 1 }] })],
      [page({ nodes: [], hasNextPage: true, endCursor: null })],
      [{ repository: { defaultBranchRef: { name: 'main' }, issue: { closedByPullRequestsReferences: {} } } }],
    ];
    for (const pages of cases) {
      await expect(opsFor(pages).ops.getMergedClosingPr(7)).rejects.toThrow();
    }
  });

  it('rejects a malformed revert search', async () => {
    const octokit: any = {
      graphql: async (query: string) =>
        query.includes('QueueRevertSearch')
          ? { search: {} }
          : page({ nodes: [{ number: 900, merged: true, baseRefName: 'main' }] }),
    };
    const ops = makeQueuePreflightOps(octokit, 'on-par', 'software-factory', { watch: async () => 'success' });
    await expect(ops.getMergedClosingPr(7)).rejects.toThrow('malformed');
  });
});
