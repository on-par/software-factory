import { describe, expect, it } from 'vitest';

import './index.js';
import { MAX_LAND_SYNC_ROUNDS } from './land-behind.js';
import { CiFailedError, CiUnverifiedError, landOpenPullRequest } from './land-pr.js';

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

const watches = (trace: string[]) => trace.filter((t) => t.startsWith('watch:'));
const pushes = (trace: string[]) => trace.filter((t) => t.startsWith('sync:push'));

describe('landOpenPullRequest: head behind origin/main (#3654)', () => {
  it('a CLEAN PR whose head is behind origin/main is synced before the first CI watch and merges only the synced, CI-verified SHA', async () => {
    const { trace, merges, logs, land } = setup({ behindFor: (sha) => sha === 'stale-sha' });
    await land();
    expect(pushes(trace)).toHaveLength(1);
    expect(trace.findIndex((t) => t.startsWith('sync:push'))).toBeLessThan(
      trace.findIndex((t) => t.startsWith('watch:')),
    );
    expect(watches(trace)).toEqual(['watch:synced-sha-1']);
    expect(merges).toEqual(['synced-sha-1']);
    expect(logs.some((l) => l.startsWith('pr_refresh') && l.includes('reason=behind round=1/3'))).toBe(true);
  });

  it('main moving during the CI watch while GitHub still reports CLEAN is caught under the land lock, synced, re-watched, and merged at the new SHA', async () => {
    // Head is fine at start; the under-lock probe of the first verified SHA reports behind once.
    const { trace, merges, land } = setup({
      head: (n) => `sha-${n}`,
      behindFor: (sha, probe) => sha === 'sha-0' && probe >= 1,
    });
    await land();
    expect(watches(trace)).toEqual(['watch:sha-0', 'watch:sha-1']);
    const pushAt = trace.indexOf('sync:push:locked');
    expect(pushAt).toBeGreaterThan(trace.indexOf('watch:sha-0'));
    expect(trace.lastIndexOf('lock:acquire', pushAt)).toBeGreaterThan(trace.indexOf('watch:sha-0'));
    expect(trace.indexOf('lock:release', pushAt)).toBeGreaterThan(pushAt);
    expect(merges).toEqual(['sha-1']);
  });

  it('CI failing on the synced head throws CiFailedError and never merges', async () => {
    const { merges, land } = setup({ behindFor: (sha) => sha === 'stale-sha', failSha: 'synced-sha-1' });
    await expect(land()).rejects.toBeInstanceOf(CiFailedError);
    expect(merges).toEqual([]);
  });

  it('main moving again after every sync stops after MAX_LAND_SYNC_ROUNDS syncs with CiUnverifiedError base kept moving and no merge', async () => {
    const { trace, merges, land } = setup({ behindFor: () => true });
    const err = await land().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CiUnverifiedError);
    expect((err as CiUnverifiedError).message).toMatch(/base kept moving/);
    expect((err as CiUnverifiedError).parkReason).toBe('ci-failed');
    expect(pushes(trace)).toHaveLength(MAX_LAND_SYNC_ROUNDS);
    expect(merges).toEqual([]);
  });

  it('a BEHIND mergeStateStatus is synced like DIRTY even when the compare probe is unavailable', async () => {
    const { trace, merges, land } = setup({ mergeState: 'BEHIND', compareThrows: true });
    await land();
    expect(pushes(trace).length).toBeGreaterThanOrEqual(1);
    expect(merges).toHaveLength(1);
  });

  it('an unavailable compare probe logs a warn and lands as before', async () => {
    const { trace, merges, logs, land } = setup({ compareThrows: true });
    await land();
    expect(pushes(trace)).toEqual([]);
    expect(watches(trace)).toEqual(['watch:stale-sha']);
    expect(merges).toEqual(['stale-sha']);
    expect(logs.some((l) => l.startsWith('warn') && l.includes('unavailable'))).toBe(true);
  });

  it('replays #3645: a CLEAN head behind main is never merged at its stale SHA', async () => {
    // Fails if the behind check or the sync is skipped: the stale head would be watched and merged as-is.
    const { trace, merges, land } = setup({
      head: (n) => (n === 0 ? 'head-kinds-485' : 'merged-with-main-kinds-498'),
      behindFor: (sha) => sha === 'head-kinds-485',
    });
    await land();
    expect(merges).not.toContain('head-kinds-485');
    expect(pushes(trace)).toHaveLength(1);
    expect(merges).toEqual(['merged-with-main-kinds-498']);
  });
});
