import { describe, expect, it, vi } from 'vitest';

import { LandConflictError, landOpenPullRequest } from './land-pr.js';
import { preflightQueuedIssue } from './queue-preflight.js';

const HEAD = 'b'.repeat(40);
const BRANCH = 'factory/7-x';

const preflightDeps = (watch: (ref: string) => Promise<'success'>) => ({
  expectedHeadRepoFullName: 'on-par/software-factory',
  findSlicePlan: async () => ({ status: 'not-found' as const }),
  findOpenPR: async () => ({
    number: 315,
    branch: BRANCH,
    headSha: 'abc123',
    headRepoFullName: 'on-par/software-factory',
  }),
  getLandState: async () => ({ isDraft: false, mergeStateStatus: 'DIRTY' }),
  watch,
  saveSlicePlan: async () => {},
  autoMergeStack: false,
  stackMode: false,
  getPullReviews: async () => {
    throw new Error('unexpected review lookup');
  },
  readIssueBody: async () => '',
  getMergedClosingPr: async () => undefined,
  getPrerequisiteState: async () => {
    throw new Error('unexpected prerequisite lookup');
  },
  getPullState: async () => 'open' as const,
  getPullRefs: async () => {
    throw new Error('unexpected refs lookup');
  },
  branchContains: async () => false,
});

const landHarness = (opts: { states: string[]; conflict?: boolean }) => {
  const order: string[] = [];
  const commands: string[] = [];
  const states = [...opts.states];
  const stdoutFor = (command: string): string => {
    if (command.startsWith('git diff --name-only --diff-filter=U')) return opts.conflict ? 'src/a.ts\0' : '';
    if (command.startsWith('git rev-parse --git-path')) return '.git/operation';
    if (command.startsWith('test -e')) return 'no';
    if (command === 'git rev-parse --verify HEAD' || command.startsWith('git merge-base')) return 'a'.repeat(40);
    return '';
  };
  const run = vi.fn(async (command: string) => {
    commands.push(command);
    if (command === 'git merge --no-edit origin/main') {
      order.push('merge');
      if (opts.conflict) throw new Error('CONFLICT');
    }
    return { stdout: stdoutFor(command) };
  });
  const watch = vi.fn(async (_o: { ref?: string }) => {
    order.push('watch');
    return 'success' as const;
  });
  const merge = vi.fn(async () => ({}));
  const octokit = {
    rest: {
      pulls: { get: vi.fn(async () => ({ data: { head: { sha: HEAD }, base: { ref: 'main' } } })), merge },
      git: { deleteRef: vi.fn(async () => ({})) },
    },
    graphql: vi.fn(async () => ({
      repository: { pullRequest: { isDraft: false, mergeStateStatus: states.length > 1 ? states.shift() : states[0] } },
    })),
  };
  const log = vi.fn();
  const land = () =>
    landOpenPullRequest({
      octokit: octokit as never,
      owner: 'o',
      repoName: 'r',
      ghRepo: 'o/r',
      repoRoot: '/repo',
      issue: 7,
      branch: BRANCH,
      worktree: '/wt',
      prNumber: 315,
      log,
      run,
      pathExists: () => true,
      watch: watch as never,
      adminMerge: false,
      syncMain: true,
    });
  return { land, order, commands, watch, merge, log, octokit };
};

describe('land syncMain (#3324)', () => {
  it('a DIRTY open PR is synced by merging origin/main and a plain push, never a force-push', async () => {
    const preflightWatch = vi.fn(async (_ref: string) => 'success' as const);
    await expect(preflightQueuedIssue({ number: 7, labels: [] }, preflightDeps(preflightWatch))).resolves.toEqual({
      kind: 'adopt',
      branch: BRANCH,
      syncMain: true,
    });
    expect(preflightWatch).not.toHaveBeenCalled();

    const h = landHarness({ states: ['DIRTY', 'CLEAN'] });
    await h.land();
    expect(h.commands).toContain('git merge --no-edit origin/main');
    expect(
      h.commands.some((c) => c.startsWith(`git push origin ${BRANCH}`) || c.startsWith(`git push origin '${BRANCH}'`)),
    ).toBe(true);
    expect(h.commands.some((c) => c.includes('--force'))).toBe(false);
    expect(h.order).toEqual(['merge', 'watch']);
    expect(h.watch.mock.calls[0]?.[0]).toMatchObject({ ref: HEAD });
    expect(h.merge).toHaveBeenCalledWith(expect.objectContaining({ sha: HEAD }));
    expect(h.log).toHaveBeenCalledWith('pr_refresh', expect.any(String), {
      prRefresh: { pr: 315, mergeStateStatus: 'DIRTY', action: 'merge-main' },
    });
  });

  it('a syncMain land whose merge changes nothing watches CI on the unchanged head and merges', async () => {
    const h = landHarness({ states: ['CLEAN'] });
    await h.land();
    expect(h.commands).toContain('git merge --no-edit origin/main');
    expect(h.commands.some((c) => c.startsWith('git push origin'))).toBe(true);
    expect(h.watch).toHaveBeenCalledTimes(1);
    expect(h.watch.mock.calls[0]?.[0]).toMatchObject({ ref: HEAD });
    expect(h.merge).toHaveBeenCalledWith(expect.objectContaining({ sha: HEAD }));
  });

  it('a syncMain land that conflicts on a non-ADR path throws LandConflictError before any push or CI watch', async () => {
    const h = landHarness({ states: ['DIRTY'], conflict: true });
    const err = await h.land().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LandConflictError);
    expect((err as Error).message).toMatch(/land sync failed on .*unresolved merge conflicts: src\/a\.ts/);
    expect(h.commands.some((c) => c.startsWith('git push'))).toBe(false);
    expect(h.commands).toContain('git merge --abort');
    expect(h.watch).not.toHaveBeenCalled();
    expect(h.merge).not.toHaveBeenCalled();
  });
});
