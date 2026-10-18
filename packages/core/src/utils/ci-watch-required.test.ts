import { describe, expect, it } from 'vitest';

import { type CiWatchProgress, type WatchChecksOptions, watchChecks } from './ci-watch.js';

const done = (name: string, conclusion: string) => ({ name, status: 'completed', conclusion });
const lint = done('lint', 'success');

function createClock() {
  let clock = 0;
  return {
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
  };
}

/** Runs per poll come from `runsAt(elapsedMs)`; statuses from `statusesAt`. */
function fakeOctokit(
  clock: { now: () => number },
  runsAt: (ms: number) => any[],
  extra: { statusesAt?: (ms: number) => any[]; noRepos?: boolean; workflows?: boolean } = {},
): any {
  const notFound = () => Object.assign(new Error('Not Found'), { status: 404 });
  return {
    rest: {
      checks: { listForRef: async () => ({ data: { check_runs: runsAt(clock.now()) } }) },
      repos: extra.noRepos
        ? {}
        : {
            getStatusChecksProtection: async () => ({ data: { contexts: ['verify'] } }),
            getBranchRules: async () => {
              throw notFound();
            },
            getCombinedStatusForRef: async () => {
              const statuses = extra.statusesAt?.(clock.now()) ?? [];
              return { data: { total_count: statuses.length, statuses, sha: 'abc' } };
            },
            getContent: async () => (extra.workflows ? { data: [{ type: 'file' }] } : Promise.reject(notFound())),
            get: async () => ({ data: { default_branch: 'main' } }),
            listCommits: async () => ({ data: [{ sha: 'c1' }] }),
          },
    },
  };
}

function watch(octokit: any, clock: ReturnType<typeof createClock>, extra: Partial<WatchChecksOptions> = {}) {
  return watchChecks({
    octokit,
    owner: 'o',
    repo: 'r',
    ref: 'sha1',
    requiredChecks: { branch: 'main' },
    sleep: clock.sleep,
    now: clock.now,
    ...extra,
  });
}

describe('watchChecks required checks (#3206)', () => {
  it('holds success while a required check is missing even when other runs passed', async () => {
    const clock = createClock();
    const progress: CiWatchProgress[] = [];
    const outcome = await watch(
      fakeOctokit(clock, () => [lint]),
      clock,
      { onProgress: (p: CiWatchProgress) => progress.push(p) },
    );

    expect(outcome).toBe('timeout');
    expect(progress[0].waitingFor).toEqual([{ name: 'verify', state: 'not reported yet' }]);
  });

  it('waits through zero runs and succeeds once the required check passes', async () => {
    const clock = createClock();
    const progress: CiWatchProgress[] = [];
    const octokit = fakeOctokit(clock, (ms) => (ms < 180_000 ? [] : [done('verify', 'success')]));
    const outcome = await watch(octokit, clock, { onProgress: (p: CiWatchProgress) => progress.push(p) });

    expect(outcome).toBe('success');
    expect(progress.length).toBeGreaterThan(0);
    expect(progress[0].total).toBe(0);
  });

  it('reports a pending required check as pending', async () => {
    const clock = createClock();
    const progress: CiWatchProgress[] = [];
    const octokit = fakeOctokit(clock, () => [{ name: 'verify', status: 'in_progress', conclusion: null }]);
    await watch(octokit, clock, { onProgress: (p: CiWatchProgress) => progress.push(p) });

    expect(progress[0].waitingFor).toEqual([{ name: 'verify', state: 'pending' }]);
  });

  it('fails when the required check fails', async () => {
    const clock = createClock();
    expect(
      await watch(
        fakeOctokit(clock, () => [done('verify', 'failure')]),
        clock,
      ),
    ).toBe('failure');
  });

  it('keeps ADR-0014: a skipped required check with everything else passing is success', async () => {
    const clock = createClock();
    expect(
      await watch(
        fakeOctokit(clock, () => [lint, done('verify', 'skipped')]),
        clock,
      ),
    ).toBe('success');
  });

  it('waits for a required context satisfied by a commit status', async () => {
    const clock = createClock();
    const octokit = fakeOctokit(clock, () => [lint], {
      statusesAt: (ms) => [{ context: 'verify', state: ms < 100_000 ? 'pending' : 'success' }],
    });
    expect(await watch(octokit, clock)).toBe('success');
  });

  it('fails when a required commit status ends failure', async () => {
    const clock = createClock();
    const octokit = fakeOctokit(clock, () => [lint], { statusesAt: () => [{ context: 'verify', state: 'error' }] });
    expect(await watch(octokit, clock)).toBe('failure');
  });

  it('keeps waiting when the combined status read throws', async () => {
    const clock = createClock();
    const octokit = fakeOctokit(clock, () => [lint]);
    octokit.rest.repos.getCombinedStatusForRef = async () => {
      throw new Error('boom');
    };
    expect(await watch(octokit, clock)).toBe('timeout');
  });

  it('falls back to the all-runs settle rule when the required lookup throws', async () => {
    const clock = createClock();
    const octokit = fakeOctokit(clock, () => [lint], { noRepos: true });
    expect(await watch(octokit, clock)).toBe('success');
  });

  it('probeNoCi without a grace never ends no-checks on a repo with workflow files', async () => {
    const clock = createClock();
    const octokit = fakeOctokit(clock, () => [], { workflows: true });
    expect(await watch(octokit, clock, { requiredChecks: undefined, probeNoCi: true })).toBe('timeout');
  });

  it('probeNoCi ends no-checks at once on a repo proven to have no CI', async () => {
    const clock = createClock();
    const octokit = fakeOctokit(clock, () => []);
    expect(await watch(octokit, clock, { requiredChecks: undefined, probeNoCi: true })).toBe('no-checks');
  });
});
