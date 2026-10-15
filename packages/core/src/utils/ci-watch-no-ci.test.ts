import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_CI_NO_CHECKS_GRACE_MS, detectNoCiConfigured, watchChecks } from './ci-watch.js';

function createClock() {
  let clock = 0;
  const now = () => clock;
  const sleeps: number[] = [];
  const sleep = async (ms: number) => {
    sleeps.push(ms);
    clock += ms;
  };
  return { now, sleep, sleeps };
}

describe('watchChecks up-front no-CI probe (#2488)', () => {
  const base = { owner: 'on-par', repo: 'software-factory', ref: 'ship-it/123-ci-poll' };
  const notFound = () => Object.assign(new Error('Not Found'), { status: 404 });

  function setup(
    opts: {
      getContent?: () => Promise<any>;
      statusFor?: (ref: string) => number;
      commits?: Array<{ sha: string }>;
    } = {},
  ) {
    const getContent = vi.fn(
      opts.getContent ??
        (async () => {
          throw notFound();
        }),
    );
    const octokit = {
      rest: {
        checks: { listForRef: async () => ({ data: { check_runs: [], total_count: 0 } }) },
        repos: {
          getContent,
          get: async () => ({ data: { default_branch: 'main' } }),
          listCommits: async () => ({ data: opts.commits ?? [{ sha: 'c1' }, { sha: 'c2' }] }),
          getCombinedStatusForRef: async ({ ref }: { ref: string }) => ({
            data: { total_count: opts.statusFor?.(ref) ?? 0, statuses: [], sha: ref },
          }),
        },
      },
    };
    return { octokit: octokit as any, getContent, ...createClock() };
  }

  it('skips the CI wait without the grace period when the repo has no workflows and no default-branch checks', async () => {
    const t = setup();
    const onNoChecks = vi.fn();

    const outcome = await watchChecks({
      ...base,
      octokit: t.octokit,
      noChecksGraceMs: DEFAULT_CI_NO_CHECKS_GRACE_MS,
      onNoChecks,
      sleep: t.sleep,
      now: t.now,
    });

    expect(outcome).toBe('no-checks');
    expect(t.now()).toBeLessThan(5_000);
    expect(t.sleeps).toEqual([]);
    expect(onNoChecks).toHaveBeenCalledTimes(1);
    expect(onNoChecks).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'no-ci-configured', defaultBranch: 'main' }),
    );
  });

  it('still waits the grace period when the PR head has a workflow file', async () => {
    const t = setup({ getContent: async () => ({ data: [{ type: 'file', name: 'ci.yml' }] }) });
    const onNoChecks = vi.fn();

    const outcome = await watchChecks({
      ...base,
      octokit: t.octokit,
      noChecksGraceMs: DEFAULT_CI_NO_CHECKS_GRACE_MS,
      onNoChecks,
      sleep: t.sleep,
      now: t.now,
    });

    expect(outcome).toBe('no-checks');
    expect(t.now()).toBeGreaterThanOrEqual(DEFAULT_CI_NO_CHECKS_GRACE_MS);
    expect(onNoChecks).toHaveBeenCalledWith(expect.objectContaining({ reason: 'grace-elapsed' }));
  });

  it('still waits the grace period when a recent default-branch commit has a status', async () => {
    const t = setup({ statusFor: (ref) => (ref === 'c2' ? 1 : 0) });

    await watchChecks({ ...base, octokit: t.octokit, noChecksGraceMs: 90_000, sleep: t.sleep, now: t.now });

    expect(t.now()).toBeGreaterThanOrEqual(90_000);
  });

  it('fails closed to the grace period when the workflow probe errors', async () => {
    const t = setup({
      getContent: async () => {
        throw Object.assign(new Error('boom'), { status: 500 });
      },
    });

    await watchChecks({ ...base, octokit: t.octokit, noChecksGraceMs: 90_000, sleep: t.sleep, now: t.now });

    expect(t.now()).toBeGreaterThanOrEqual(90_000);
  });

  it('does not probe for CI when noChecksGraceMs is unset', async () => {
    const t = setup();

    await watchChecks({ ...base, octokit: t.octokit, deadlineMs: 30_000, sleep: t.sleep, now: t.now });

    expect(t.getContent).not.toHaveBeenCalled();
  });

  it('detectNoCiConfigured returns null when the default branch has no commits', async () => {
    const t = setup({ commits: [] });

    expect(await detectNoCiConfigured(t.octokit, 'on-par', 'software-factory', 'main')).toBeNull();
  });
});
