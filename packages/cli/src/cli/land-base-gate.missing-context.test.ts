import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import './index.js';
import { landBaseGate } from './land-base-gate.js';
import { landOpenPullRequest } from './land-pr.js';

const merge = vi.fn(async () => ({ data: { merged: true } }));
const octokit = {
  graphql: async () => ({ repository: { pullRequest: { mergeStateStatus: 'CLEAN' } } }),
  rest: {
    pulls: {
      get: async () => ({ data: { head: { sha: 'pr' }, base: { ref: 'main' }, merge_commit_sha: 'mergesha' } }),
      merge,
    },
    git: { deleteRef: async () => ({}) },
    repos: {
      getBranch: async () => ({ data: { commit: { sha: 'abcdef1234567890' } } }),
      getStatusChecksProtection: async () => ({ data: { contexts: ['test'] } }),
      getBranchRules: async () => ({ data: [] }),
      compareCommitsWithBasehead: async () => ({ data: { status: 'ahead' } }),
    },
    checks: { listForRef: async () => ({ data: { check_runs: [] } }) },
    actions: { listWorkflowRunsForRepo: async () => ({ data: { workflow_runs: [] } }) },
  },
} as never;

const dirs = createTempDirs();
afterEach(async () => {
  await dirs.cleanup();
  merge.mockClear();
});

const clock = () => {
  let now = 0;
  return { now: () => now, sleep: async (ms: number) => void (now += ms), slept: () => now };
};
const build = (log = vi.fn(), c = clock()) => ({
  log,
  c,
  gate: landBaseGate({
    octokit,
    owner: 'o',
    repo: 'r',
    prNumber: 2,
    state: dirs.makeSync('missing-ctx-'),
    log,
    now: c.now,
    sleep: c.sleep,
  }),
});

describe('land base gate with a required check that never runs on the base', () => {
  it('check(false) does not throw BaseCiPendingError for a missing-only required context', async () => {
    await expect(build().gate.check(false)).resolves.toBeUndefined();
  });
  it('check() proceeds after the short grace instead of waiting 30 minutes', async () => {
    const { gate, c } = build();
    await expect(gate.check()).resolves.toBeUndefined();
    expect(c.slept()).toBeGreaterThanOrEqual(120_000);
    expect(c.slept()).toBeLessThan(30 * 60_000);
  });
  it('logs one warn event naming the missing context across check() and check(false)', async () => {
    const { gate, log } = build();
    await gate.check();
    await gate.check(false);
    const warns = log.mock.calls.filter(([kind]) => kind === 'warn');
    expect(warns).toHaveLength(1);
    expect(warns[0]?.[1]).toContain('test');
  });
  it('lets land merge when required check test has no run on the base head', async () => {
    const { gate } = build();
    await landOpenPullRequest({
      octokit,
      owner: 'o',
      repoName: 'r',
      ghRepo: 'o/r',
      repoRoot: '/r',
      issue: 1,
      branch: 'b',
      worktree: '/w',
      prNumber: 2,
      log: vi.fn(),
      skipCI: true,
      adminMerge: false,
      sleep: async () => {},
      run: vi.fn(),
      behindProbe: async () => false,
      baseGate: gate,
    });
    expect(merge).toHaveBeenCalledTimes(1);
  });
});
