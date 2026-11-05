// packages/cli/src/cli/land-pr.land-deferred.test.ts — a moving base defers the land instead of parking (#3957)

import { describe, expect, it } from 'vitest';

import './index.js';
import { MAX_LAND_SYNC_ROUNDS } from './land-behind.js';
import { CiFailedError, CiUnverifiedError, LandDeferredError, landOpenPullRequest } from './land-pr.js';

type Opts = {
  mergeState?: string;
  /** Compare reports behind for this head SHA (called once per probe). */
  behindFor?: (sha: string, probe: number) => boolean;
  compareThrows?: boolean;
  head?: (syncs: number) => string;
  failSha?: string;
};

function setup({ mergeState = 'CLEAN', behindFor = () => false, compareThrows = false, head, failSha }: Opts = {}) {
  const trace: string[] = [];
  const merges: string[] = [];
  const logs: string[] = [];
  let syncs = 0;
  let probes = 0;
  let inLock = false;
  const headSha = head ?? ((n: number) => (n === 0 ? 'stale-sha' : `synced-sha-${n}`));
  const octokit: any = {
    graphql: async () => ({
      repository: {
        pullRequest: {
          id: 'PR_1',
          isDraft: false,
          mergeStateStatus: mergeState === 'BEHIND' && syncs > 0 ? 'CLEAN' : mergeState,
        },
      },
    }),
    rest: {
      pulls: {
        get: async () => ({ data: { head: { sha: headSha(syncs) }, base: { ref: 'main' } } }),
        merge: async (args: any) => {
          merges.push(args.sha);
        },
      },
      repos: {
        compareCommitsWithBasehead: async (args: { basehead: string }) => {
          if (compareThrows) throw new Error('compare down');
          const sha = args.basehead.split('...')[1] as string;
          return { data: { behind_by: behindFor(sha, probes++) ? 1 : 0 } };
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
    if (command.startsWith('git diff --name-only --diff-filter=U -z')) return { stdout: '' };
    if (command.startsWith('git push')) {
      syncs++;
      trace.push(inLock ? 'sync:push:locked' : 'sync:push');
    }
    return { stdout: '' };
  };
  const watch = async (opts: { ref: string }) => {
    if (inLock) throw new Error('watch ran inside the land lock');
    trace.push(`watch:${opts.ref}`);
    return opts.ref === failSha ? ('failure' as const) : ('success' as const);
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
      branch: 'ship-it/20-behind',
      worktree: '/repo-factory-20',
      prNumber: 123,
      log: (_t, msg) => logs.push(`${_t}: ${msg}`),
      run,
      pathExists: () => true,
      sleep: async () => {
        throw new Error('sleep should not be called');
      },
      adminMerge: false,
      watch: watch as any,
      withLock,
    });
  return { trace, merges, logs, land };
}

describe('landOpenPullRequest: moving base is deferred (#3957)', () => {
  it('a base that keeps moving throws LandDeferredError with the base kept moving message', async () => {
    const { merges, logs, land } = setup({ behindFor: () => true });
    const err = await land().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LandDeferredError);
    expect(err).toBeInstanceOf(CiUnverifiedError);
    const msg = `PR #123 on ship-it/20-behind: base kept moving — synced ${MAX_LAND_SYNC_ROUNDS} times and origin/main moved again; refusing to merge an unverified head`;
    expect((err as LandDeferredError).message).toBe(msg);
    expect((err as LandDeferredError).branch).toBe('ship-it/20-behind');
    expect((err as LandDeferredError).prNumber).toBe(123);
    expect(logs).toContain(`land-deferred: ${msg}`);
    expect(logs.some((l) => l.startsWith('ci-failed'))).toBe(false);
    expect(merges).toEqual([]);
  });

  it('a CI failure after a sync still throws CiFailedError, not LandDeferredError', async () => {
    const { land } = setup({ behindFor: (sha) => sha === 'stale-sha', failSha: 'synced-sha-1' });
    const err = await land().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CiFailedError);
    expect(err).not.toBeInstanceOf(LandDeferredError);
  });
});
