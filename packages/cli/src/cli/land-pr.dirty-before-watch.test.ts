import { describe, expect, it } from 'vitest';

import './index.js';
import { LandConflictError, landOpenPullRequest } from './land-pr.js';

function setup(initial: 'DIRTY' | 'MERGEABLE', conflict = false) {
  const trace: string[] = [];
  const merges: string[] = [];
  let synced = false;
  let inLock = false;
  const octokit: any = {
    graphql: async () => ({
      repository: { pullRequest: { id: 'PR_1', isDraft: false, mergeStateStatus: synced ? 'MERGEABLE' : initial } },
    }),
    rest: {
      pulls: {
        get: async () => ({ data: { head: { sha: synced || initial !== 'DIRTY' ? 'synced-sha' : 'stale-sha' } } }),
        merge: async (args: any) => {
          merges.push(args.sha);
        },
      },
      git: { deleteRef: async () => {} },
    },
  };
  const run = async (command: string) => {
    if (command === 'git status --porcelain -z') return { stdout: '' };
    if (command.startsWith('git rev-parse --git-path')) return { stdout: '.git/operation' };
    if (command.startsWith('test -e')) return { stdout: 'no' };
    if (command === 'git rev-parse --verify HEAD' || command.startsWith('git merge-base'))
      return { stdout: 'a'.repeat(40) };
    if (command.startsWith('git diff --diff-filter=A')) return { stdout: '' };
    if (command === 'git merge --no-edit origin/main' && conflict) throw new Error('CONFLICT');
    if (command.startsWith('git diff --name-only --diff-filter=U -z')) return { stdout: conflict ? 'source.ts\0' : '' };
    if (command.startsWith('git push')) {
      synced = true;
      trace.push('sync:push');
    }
    return { stdout: '' };
  };
  const watch = async (opts: { ref: string }) => {
    if (inLock) throw new Error('watch ran inside the land lock');
    trace.push(`watch:${opts.ref}`);
    return opts.ref === 'stale-sha' ? ('timeout' as const) : ('success' as const);
  };
  const withLock = async <T>(fn: () => Promise<T>): Promise<T> => {
    trace.push('lock:acquire');
    inLock = true;
    try {
      return await fn();
    } finally {
      inLock = false;
      trace.push('lock:release');
    }
  };
  const land = () =>
    landOpenPullRequest({
      octokit,
      owner: 'on-par',
      repoName: 'software-factory',
      ghRepo: 'on-par/software-factory',
      repoRoot: '/repo',
      issue: 20,
      branch: 'ship-it/20-dirty',
      worktree: '/repo-factory-20',
      prNumber: 123,
      log: () => {},
      run,
      pathExists: () => true,
      sleep: async () => {
        throw new Error('sleep should not be called');
      },
      adminMerge: false,
      watch: watch as any,
      withLock,
    });
  return { trace, merges, land };
}

const watches = (trace: string[]) => trace.filter((t) => t.startsWith('watch:'));

describe('landOpenPullRequest: DIRTY PR before the CI watch (#3533)', () => {
  it('a PR that is DIRTY at land start is synced before CI is watched', async () => {
    const { trace, merges, land } = setup('DIRTY');
    await expect(land()).resolves.toBeUndefined();
    expect(trace.indexOf('sync:push')).toBeGreaterThanOrEqual(0);
    expect(trace.indexOf('sync:push')).toBeLessThan(trace.findIndex((t) => t.startsWith('watch:')));
    expect(watches(trace)).toEqual(['watch:synced-sha']);
    expect(merges).toEqual(['synced-sha']);
  });

  it('a PR that is MERGEABLE at land start is not synced and CI is watched once', async () => {
    const { trace, merges, land } = setup('MERGEABLE');
    await land();
    expect(trace).not.toContain('sync:push');
    expect(watches(trace)).toEqual(['watch:synced-sha']);
    expect(merges).toEqual(['synced-sha']);
  });

  it('a DIRTY PR whose sync conflicts parks as conflict without watching CI', async () => {
    const { trace, land } = setup('DIRTY', true);
    const err = await land().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LandConflictError);
    expect((err as LandConflictError).parkReason).toBe('conflict');
    expect(watches(trace)).toEqual([]);
  });
});
