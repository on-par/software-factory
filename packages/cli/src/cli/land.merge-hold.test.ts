// packages/cli/src/cli/land.merge-hold.test.ts — waitForMerge/landIssue opt-in hooks for run-issue --merge (#3905)

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import './index.js';
import { landIssue, waitForMerge } from './land.js';
import { LandFailureError, MergeGatedError } from './land-pr.js';
import { type LandRuntime, setLandRuntime } from './land-runtime.js';

const fakeConfig: any = {
  merge: { auto: true, comment: '' },
  ci: { skip: false, comment: '' },
  filing: {
    enabled: true,
    excludeReasons: [],
    repeatThreshold: 3,
    maxPerRun: 5,
    maxPerDay: 20,
    selfFixLabel: 'no-auto-merge',
    bugLabels: ['bug'],
    sensitivePaths: [],
  },
};

const paths: any = { events: '/e', stop: '/STOP' };

function run(deps: Record<string, unknown>, events: any[] = []) {
  return waitForMerge(7, 'ship-it/7-x', '/repo', 'on-par/software-factory', paths, {
    createOctokit: () => ({}) as any,
    pathExists: () => false,
    loadConfig: () => fakeConfig,
    checkMerged: async () => false,
    mergeEnabled: () => true,
    emitEvent: (_f: string, type: string, _i: string | number, msg: string) => events.push([type, msg]),
    ...deps,
  });
}

describe('waitForMerge holdWhenGated (#3905)', () => {
  it('holdWhenGated throws MergeGatedError instead of polling', async () => {
    const events: any[] = [];
    const sleep = vi.fn(async () => {});
    const err = await run(
      {
        holdWhenGated: true,
        sleep,
        listIssueLabels: async () => ['no-auto-merge'],
        lookupPr: async () => ({ number: 42, merged: false }),
        land: async () => {
          throw new Error('land should not be called');
        },
      },
      events,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(MergeGatedError);
    expect(err.label).toBe('no-auto-merge');
    expect(err.prNumber).toBe(42);
    expect(sleep).not.toHaveBeenCalled();
    expect(events.some((e) => e[0] === 'merge-gated')).toBe(true);
  });

  it('falls back to PR 0 when the PR lookup fails', async () => {
    const err = await run({
      holdWhenGated: true,
      listIssueLabels: async () => ['no-auto-merge'],
      lookupPr: async () => {
        throw new Error('boom');
      },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(MergeGatedError);
    expect(err.prNumber).toBe(0);
  });

  it('keeps polling when holdWhenGated is unset', async () => {
    const sleep = vi.fn(async () => {
      throw new Error('slept');
    });
    const err = await run({ sleep, listIssueLabels: async () => ['no-auto-merge'] }).catch((e) => e);
    expect(err.message).toBe('slept');
  });

  it('forwards mergeOverrides and issueless into land and reads labels on the PR number', async () => {
    const land = vi.fn(async (..._args: unknown[]) => ({ branch: 'ship-it/7-x', prNumber: 42 }));
    const listIssueLabels = vi.fn(async () => [] as string[]);
    const mergeOverrides = { auto: true, admin: true };
    await run({
      mergeOverrides,
      issueless: true,
      landBranch: 'ship-it/7-x',
      land,
      listIssueLabels,
      lookupPr: async () => ({ number: 42, merged: false }),
    });
    expect(listIssueLabels).toHaveBeenCalledWith(expect.anything(), 'on-par', 'software-factory', 42);
    expect(land.mock.calls[0]?.[7]).toMatchObject({ mergeOverrides, issueless: true, branch: 'ship-it/7-x' });
  });
});

// landIssue reads its ops through landRuntime(); layer inert git/shell/CI doubles over the defaults.
describe('landIssue mergeOverrides / issueless (#3905)', () => {
  const tmp = createTempDirs();
  let repoRoot = '';
  let restore: (() => LandRuntime) | undefined;
  let exec: ReturnType<typeof vi.fn>;
  let octokit: any;
  const BRANCH = 'ship-it/5-fix-the-bug';

  const landPaths = (): any => {
    const state = join(repoRoot, '.factory', 'state');
    return {
      state,
      events: join(state, 'events.ndjson'),
      mergeLock: join(state, 'merge.lock'),
      gitLock: join(state, 'git.lock'),
      tierDemotions: join(state, 'tier-demotions.jsonl'),
      config: join(repoRoot, '.factory', 'config.json'),
    };
  };

  const makeOctokit = () => ({
    rest: {
      issues: {
        get: vi.fn(async () => ({ data: { title: 'Fix the bug' } })),
        listLabelsOnIssue: vi.fn(async () => ({ data: [] })),
        listComments: vi.fn(async () => ({ data: [] })),
        addLabels: vi.fn(async () => ({ data: [] })),
        createComment: vi.fn(async () => ({ data: {} })),
      },
      users: { getAuthenticated: vi.fn(async () => ({ data: { id: 7 } })) },
      pulls: {
        list: vi.fn(async ({ state }: any) =>
          state === 'open'
            ? { data: [{ number: 77, head: { ref: BRANCH, repo: { full_name: 'o/r' }, sha: 'abc' }, body: '' }] }
            : { data: [] },
        ),
        get: vi.fn(async () => ({
          data: { head: { sha: 'abc' }, base: { ref: 'main' }, merge_commit_sha: 'merged', body: '' },
        })),
        listFiles: vi.fn(async () => ({ data: [{ filename: 'docs/readme.md' }] })),
        update: vi.fn(async () => ({})),
        merge: vi.fn(async () => ({})),
      },
      git: { deleteRef: vi.fn(async () => ({})) },
      repos: {
        getBranch: vi.fn(async () => ({ data: { commit: { sha: 'base' } } })),
        getStatusChecksProtection: vi.fn(async () => ({ data: { contexts: [] } })),
        getBranchRules: vi.fn(async () => ({ data: [] })),
      },
      actions: { listWorkflowRunsForRepo: vi.fn(async () => ({ data: { workflow_runs: [] } })) },
      checks: { listForRef: vi.fn(async () => ({ data: { check_runs: [] } })) },
      search: { issuesAndPullRequests: vi.fn(async () => ({ data: { items: [] } })) },
    },
    graphql: vi.fn(async (query: string) =>
      query.trimStart().startsWith('query')
        ? { repository: { pullRequest: { id: 'PR_ID', isDraft: false, mergeStateStatus: 'CLEAN' } } }
        : {},
    ),
  });

  beforeEach(() => {
    repoRoot = tmp.makeSync('factory-land-hold-');
    mkdirSync(join(repoRoot, '.git', 'info'), { recursive: true });
    mkdirSync(join(repoRoot, '.factory', 'state', 'plans'), { recursive: true });
    for (const k of ['FACTORY_LOCAL_ONLY', 'FACTORY_MERGE', 'FACTORY_MERGE_ADMIN', 'FACTORY_SKIP_CI'])
      vi.stubEnv(k, undefined);
    exec = vi.fn(async () => ({ stdout: '', stderr: '' }));
    octokit = makeOctokit();
    const ops: Record<string, Record<string, unknown>> = {
      configLoaders: {
        loadFactoryConfigForRepo: () => ({
          merge: { auto: true, comment: '' },
          worktree: { parent: '../', gcTtlDays: 7, autoGcOnRun: false },
          sandbox: { enabled: false, network: { allow: [] }, resources: { cpuMs: 1, memMb: 1 } },
          sweep: { loopIntervalSeconds: 300, staleThresholdMultiplier: 2 },
          filing: { selfFixLabel: 'no-auto-merge', enabled: false },
        }),
        loadRepoConfig: () => ({}),
      },
      gitOps: {
        setupWorktree: vi.fn(async () => undefined),
        cleanupWorktree: vi.fn(async () => {}),
        gitFetch: vi.fn(async () => {}),
      },
      internalOps: { watchChecks: vi.fn(async () => 'success') },
      shellOps: {
        exec,
        execSync: vi.fn(() => {
          throw new Error('no cli available');
        }),
      },
    };
    restore = setLandRuntime(() => {
      const rt = restore!();
      return {
        ...rt,
        configLoaders: { ...rt.configLoaders, ...ops.configLoaders },
        gitOps: { ...rt.gitOps, ...ops.gitOps },
        internalOps: { ...rt.internalOps, ...ops.internalOps },
        shellOps: { ...rt.shellOps, ...ops.shellOps },
      } as LandRuntime;
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    if (restore) setLandRuntime(restore);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await tmp.cleanup();
  });

  const land = (opts: Record<string, unknown>) =>
    landIssue(5, repoRoot, 'o/r', landPaths(), octokit, false, undefined, { enforceRisk: true, ...opts });

  it('forwards mergeOverrides admin into landIssue', async () => {
    await land({ branch: BRANCH, mergeOverrides: { admin: true } });
    expect(exec.mock.calls.some((c) => String(c[0]).includes('--admin'))).toBe(true);
    exec.mockClear();
    await land({ branch: BRANCH });
    expect(exec.mock.calls.some((c) => String(c[0]).includes('--admin'))).toBe(false);
  });

  it('issueless lands by branch without reading the issue title or issue labels', async () => {
    await expect(land({ branch: BRANCH, issueless: true })).resolves.toEqual({ branch: BRANCH, prNumber: 77 });
    expect(octokit.rest.issues.get).not.toHaveBeenCalled();
    const labelReads = octokit.rest.issues.listLabelsOnIssue.mock.calls.map((c: any[]) => c[0].issue_number);
    expect(labelReads).toEqual([77]);
  });

  it('issueless without a branch fails with exit 1', async () => {
    const err = await land({ issueless: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LandFailureError);
    expect((err as LandFailureError).code).toBe(1);
  });
});
