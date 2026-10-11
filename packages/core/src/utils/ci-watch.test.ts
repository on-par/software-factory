import { describe, expect, it, vi } from 'vitest';

import {
  classifyCiFailure,
  DEFAULT_CI_NO_CHECKS_GRACE_MS,
  resolveCiNoChecksGraceMs,
  watchChecks,
  watchChecksWithInfraRerun,
} from './ci-watch.js';

function scriptChecks(sequence: any[][]) {
  let i = 0;
  const listForRef = async (_args: any) => {
    const runs = sequence[Math.min(i, sequence.length - 1)];
    i++;
    return { data: { check_runs: runs } };
  };
  return { listForRef, callCount: () => i };
}

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

const pending = [{ status: 'in_progress', conclusion: null }];
const allSuccess = [{ status: 'completed', conclusion: 'success' }];
const oneFailure = [
  { status: 'completed', conclusion: 'success' },
  { status: 'completed', conclusion: 'failure' },
];

describe('watchChecks', () => {
  it('returns success once all checks complete, backing off between polls', async () => {
    const { listForRef } = scriptChecks([pending, pending, allSuccess]);
    const { now, sleep, sleeps } = createClock();
    const octokit = { rest: { checks: { listForRef } } };

    const outcome = await watchChecks({
      octokit: octokit as any,
      owner: 'on-par',
      repo: 'software-factory',
      ref: 'ship-it/123-ci-poll',
      sleep,
      now,
    });

    expect(outcome).toBe('success');
    expect(sleeps).toEqual([15_000, 30_000]);
  });

  it('fails fast on the first poll where any check has failed', async () => {
    const { listForRef } = scriptChecks([pending, oneFailure]);
    const { now, sleep, sleeps } = createClock();
    const octokit = { rest: { checks: { listForRef } } };

    const outcome = await watchChecks({
      octokit: octokit as any,
      owner: 'on-par',
      repo: 'software-factory',
      ref: 'ship-it/123-ci-poll',
      sleep,
      now,
    });

    expect(outcome).toBe('failure');
    expect(sleeps).toEqual([15_000]);
  });

  it('times out when checks never complete before the deadline', async () => {
    const { listForRef } = scriptChecks([pending]);
    const { now, sleep } = createClock();
    const octokit = { rest: { checks: { listForRef } } };

    const outcome = await watchChecks({
      octokit: octokit as any,
      owner: 'on-par',
      repo: 'software-factory',
      ref: 'ship-it/123-ci-poll',
      sleep,
      now,
    });

    expect(outcome).toBe('timeout');
  });

  it('backs off exponentially, capping at maxIntervalMs', async () => {
    const { listForRef } = scriptChecks([pending]);
    const { now, sleep, sleeps } = createClock();
    const octokit = { rest: { checks: { listForRef } } };

    await watchChecks({
      octokit: octokit as any,
      owner: 'on-par',
      repo: 'software-factory',
      ref: 'ship-it/123-ci-poll',
      sleep,
      now,
    });

    expect(sleeps[0]).toBe(15_000);
    expect(sleeps[1]).toBe(30_000);
    expect(sleeps[2]).toBe(60_000);
    for (let i = 2; i < sleeps.length; i++) {
      expect(sleeps[i]).toBe(60_000);
    }
    for (let i = 1; i < sleeps.length; i++) {
      expect(sleeps[i]).toBeGreaterThanOrEqual(sleeps[i - 1]);
    }
  });

  it.each(['success', 'neutral', 'skipped'])('treats a completed %s conclusion as passing', async (conclusion) => {
    const { listForRef } = scriptChecks([[{ status: 'completed', conclusion }]]);
    const { now, sleep } = createClock();
    const octokit = { rest: { checks: { listForRef } } };

    const outcome = await watchChecks({
      octokit: octokit as any,
      owner: 'on-par',
      repo: 'software-factory',
      ref: 'x',
      sleep,
      now,
    });

    expect(outcome).toBe('success');
  });

  it.each(['failure', 'cancelled', 'timed_out', 'action_required', 'stale', 'startup_failure'])(
    'treats a completed %s conclusion as blocking',
    async (conclusion) => {
      const { listForRef } = scriptChecks([[{ status: 'completed', conclusion }]]);
      const { now, sleep } = createClock();
      const octokit = { rest: { checks: { listForRef } } };

      const outcome = await watchChecks({
        octokit: octokit as any,
        owner: 'on-par',
        repo: 'software-factory',
        ref: 'x',
        sleep,
        now,
      });

      expect(outcome).toBe('failure');
    },
  );

  it.each([null, 'some_future_state'])('treats a completed run with conclusion %s as blocking', async (conclusion) => {
    const { listForRef } = scriptChecks([[{ status: 'completed', conclusion }]]);
    const { now, sleep } = createClock();
    const octokit = { rest: { checks: { listForRef } } };

    const outcome = await watchChecks({
      octokit: octokit as any,
      owner: 'on-par',
      repo: 'software-factory',
      ref: 'x',
      sleep,
      now,
    });

    expect(outcome).toBe('failure');
  });

  it('treats a mix of success and skipped as passing', async () => {
    const { listForRef } = scriptChecks([
      [
        { status: 'completed', conclusion: 'success' },
        { status: 'completed', conclusion: 'skipped' },
      ],
    ]);
    const { now, sleep } = createClock();
    const octokit = { rest: { checks: { listForRef } } };

    const outcome = await watchChecks({
      octokit: octokit as any,
      owner: 'on-par',
      repo: 'software-factory',
      ref: 'x',
      sleep,
      now,
    });

    expect(outcome).toBe('success');
  });

  it('treats a mix of success and cancelled as blocking', async () => {
    const { listForRef } = scriptChecks([
      [
        { status: 'completed', conclusion: 'success' },
        { status: 'completed', conclusion: 'cancelled' },
      ],
    ]);
    const { now, sleep } = createClock();
    const octokit = { rest: { checks: { listForRef } } };

    const outcome = await watchChecks({
      octokit: octokit as any,
      owner: 'on-par',
      repo: 'software-factory',
      ref: 'x',
      sleep,
      now,
    });

    expect(outcome).toBe('failure');
  });

  it('pages through all check runs, catching a blocking conclusion on page 2', async () => {
    const calls: any[] = [];
    const listForRef = async (args: any) => {
      calls.push(args);
      if (args.page === 1) {
        const runs = Array.from({ length: 100 }, () => ({ status: 'completed', conclusion: 'success' }));
        return { data: { check_runs: runs } };
      }
      return { data: { check_runs: [{ status: 'completed', conclusion: 'cancelled' }] } };
    };
    const { now, sleep } = createClock();
    const octokit = { rest: { checks: { listForRef } } };

    const outcome = await watchChecks({
      octokit: octokit as any,
      owner: 'on-par',
      repo: 'software-factory',
      ref: 'x',
      sleep,
      now,
    });

    expect(outcome).toBe('failure');
    expect(calls[0].per_page).toBe(100);
    expect(calls.some((c) => c.page === 2)).toBe(true);
  });

  it('keeps polling when page 2 has a still-running check instead of returning success early', async () => {
    let page2Calls = 0;
    const listForRef = async (args: any) => {
      if (args.page === 1) {
        const runs = Array.from({ length: 100 }, () => ({ status: 'completed', conclusion: 'success' }));
        return { data: { check_runs: runs } };
      }
      page2Calls++;
      if (page2Calls === 1) return { data: { check_runs: [{ status: 'in_progress', conclusion: null }] } };
      return { data: { check_runs: [{ status: 'completed', conclusion: 'success' }] } };
    };
    const { now, sleep, sleeps } = createClock();
    const octokit = { rest: { checks: { listForRef } } };

    const outcome = await watchChecks({
      octokit: octokit as any,
      owner: 'on-par',
      repo: 'software-factory',
      ref: 'x',
      sleep,
      now,
    });

    expect(outcome).toBe('success');
    expect(sleeps).toEqual([15_000, 30_000]);
  });

  it('recovers from transient errors and still succeeds', async () => {
    let call = 0;
    const listForRef = async () => {
      call++;
      if (call <= 2) throw new Error('ECONNRESET');
      return { data: { check_runs: allSuccess } };
    };
    const { now, sleep, sleeps } = createClock();
    const octokit = { rest: { checks: { listForRef } } };

    const outcome = await watchChecks({
      octokit: octokit as any,
      owner: 'on-par',
      repo: 'software-factory',
      ref: 'x',
      sleep,
      now,
    });

    expect(outcome).toBe('success');
    expect(sleeps).toEqual([15_000, 30_000, 60_000]);
  });

  it('gives up as timeout, without rejecting, after maxPollErrors consecutive failures', async () => {
    const listForRef = async () => {
      throw new Error('down');
    };
    const { now, sleep } = createClock();
    const octokit = { rest: { checks: { listForRef } } };

    const outcome = await watchChecks({
      octokit: octokit as any,
      owner: 'on-par',
      repo: 'software-factory',
      ref: 'x',
      sleep,
      now,
      maxPollErrors: 3,
    });

    expect(outcome).toBe('timeout');
  });

  it('resets the consecutive poll-error counter after a successful poll', async () => {
    const sequence = ['throw', 'pending', 'throw', 'throw', 'success'];
    let i = 0;
    const listForRef = async () => {
      const step = sequence[i];
      i++;
      if (step === 'throw') throw new Error('down');
      if (step === 'pending') return { data: { check_runs: pending } };
      return { data: { check_runs: allSuccess } };
    };
    const { now, sleep } = createClock();
    const octokit = { rest: { checks: { listForRef } } };

    const outcome = await watchChecks({
      octokit: octokit as any,
      owner: 'on-par',
      repo: 'software-factory',
      ref: 'x',
      sleep,
      now,
      maxPollErrors: 3,
    });

    expect(outcome).toBe('success');
  });

  it('returns timeout when zero check runs ever register before the deadline', async () => {
    const listForRef = async () => ({ data: { check_runs: [] } });
    const { now, sleep, sleeps } = createClock();
    const octokit = { rest: { checks: { listForRef } } };

    const outcome = await watchChecks({
      octokit: octokit as any,
      owner: 'on-par',
      repo: 'software-factory',
      ref: 'x',
      sleep,
      now,
    });

    expect(outcome).toBe('timeout');
    expect(sleeps.length).toBeGreaterThan(0);
  });

  it('does not return success from a check-run set that is still growing (#602)', async () => {
    const lintSuccess = { status: 'completed', conclusion: 'success' };
    const integrationInProgress = { status: 'in_progress', conclusion: null };
    const integrationSuccess = { status: 'completed', conclusion: 'success' };
    const { listForRef, callCount } = scriptChecks([
      [lintSuccess],
      [lintSuccess, integrationInProgress],
      [lintSuccess, integrationSuccess],
    ]);
    const { now, sleep } = createClock();
    const octokit = { rest: { checks: { listForRef } } };

    const outcome = await watchChecks({
      octokit: octokit as any,
      owner: 'on-par',
      repo: 'software-factory',
      ref: 'x',
      sleep,
      now,
    });

    expect(outcome).toBe('success');
    expect(callCount()).toBeGreaterThanOrEqual(3);
  });

  it(
    'returns failure when a check that registers late reports a non-passing conclusion, ' +
      'even though the one-element set was already green (#602)',
    async () => {
      const lintSuccess = { status: 'completed', conclusion: 'success' };
      const integrationInProgress = { status: 'in_progress', conclusion: null };
      const integrationFailure = { status: 'completed', conclusion: 'failure' };
      const { listForRef } = scriptChecks([
        [lintSuccess],
        [lintSuccess, integrationInProgress],
        [lintSuccess, integrationFailure],
      ]);
      const { now, sleep } = createClock();
      const octokit = { rest: { checks: { listForRef } } };

      const outcome = await watchChecks({
        octokit: octokit as any,
        owner: 'on-par',
        repo: 'software-factory',
        ref: 'x',
        sleep,
        now,
      });

      expect(outcome).toBe('failure');
    },
  );

  it('restarts the settle window when the observed check-run count changes', async () => {
    const a = { status: 'completed', conclusion: 'success' };
    const b = { status: 'completed', conclusion: 'success' };
    const { listForRef } = scriptChecks([[a], [a, b]]);
    const { now, sleep, sleeps } = createClock();
    const octokit = { rest: { checks: { listForRef } } };

    const outcome = await watchChecks({
      octokit: octokit as any,
      owner: 'on-par',
      repo: 'software-factory',
      ref: 'x',
      sleep,
      now,
    });

    expect(outcome).toBe('success');
    expect(sleeps.length).toBeGreaterThanOrEqual(2);
  });

  it('settleMs: 0 restores first-poll-completes behaviour', async () => {
    const { listForRef } = scriptChecks([allSuccess]);
    const { now, sleep, sleeps } = createClock();
    const octokit = { rest: { checks: { listForRef } } };

    const outcome = await watchChecks({
      octokit: octokit as any,
      owner: 'on-par',
      repo: 'software-factory',
      ref: 'x',
      sleep,
      now,
      settleMs: 0,
    });

    expect(outcome).toBe('success');
    expect(sleeps).toEqual([]);
  });

  it('minChecks met bypasses the settle window entirely', async () => {
    const { listForRef } = scriptChecks([
      [
        { status: 'completed', conclusion: 'success' },
        { status: 'completed', conclusion: 'success' },
      ],
    ]);
    const { now, sleep, sleeps } = createClock();
    const octokit = { rest: { checks: { listForRef } } };

    const outcome = await watchChecks({
      octokit: octokit as any,
      owner: 'on-par',
      repo: 'software-factory',
      ref: 'x',
      sleep,
      now,
      minChecks: 2,
    });

    expect(outcome).toBe('success');
    expect(sleeps).toEqual([]);
  });

  it('minChecks unmet never returns success, even if the settle window would otherwise elapse', async () => {
    const { listForRef } = scriptChecks([allSuccess]);
    const { now, sleep } = createClock();
    const octokit = { rest: { checks: { listForRef } } };

    const outcome = await watchChecks({
      octokit: octokit as any,
      owner: 'on-par',
      repo: 'software-factory',
      ref: 'x',
      sleep,
      now,
      minChecks: 3,
    });

    expect(outcome).toBe('timeout');
  });

  it('minChecks unmet still fails fast on a red conclusion', async () => {
    const { listForRef } = scriptChecks([
      [
        { status: 'completed', conclusion: 'success' },
        { status: 'completed', conclusion: 'failure' },
      ],
    ]);
    const { now, sleep, sleeps } = createClock();
    const octokit = { rest: { checks: { listForRef } } };

    const outcome = await watchChecks({
      octokit: octokit as any,
      owner: 'on-par',
      repo: 'software-factory',
      ref: 'x',
      sleep,
      now,
      minChecks: 5,
    });

    expect(outcome).toBe('failure');
    expect(sleeps).toEqual([]);
  });
});

describe('classifyCiFailure', () => {
  const noRunnerJob = { conclusion: 'failure', runner_id: null, runner_name: null, steps: [] };
  const cancelledBeforeStartJob = {
    conclusion: 'cancelled',
    runner_id: 42,
    runner_name: 'GitHub Actions 42',
    steps: [{ status: 'queued', started_at: null }],
  };
  const zeroStepsJob = { conclusion: 'failure', runner_id: 42, runner_name: 'GitHub Actions 42', steps: [] };
  const realTestFailureJob = {
    conclusion: 'failure',
    runner_id: 42,
    runner_name: 'GitHub Actions 42',
    steps: [
      { name: 'Set up job', status: 'completed', conclusion: 'success', started_at: '2026-10-01T00:00:00Z' },
      { name: 'Run tests', status: 'completed', conclusion: 'failure', started_at: '2026-10-01T00:01:00Z' },
    ],
  };

  it('classifies a failed job with no runner assigned as infra', () => {
    expect(classifyCiFailure(noRunnerJob)).toBe('infra');
    expect(classifyCiFailure({ conclusion: 'failure', runner_id: 0, runner_name: '', steps: undefined })).toBe('infra');
  });

  it('classifies a job cancelled before any step started as infra', () => {
    expect(classifyCiFailure(cancelledBeforeStartJob)).toBe('infra');
  });

  it('classifies a failed job that ran zero steps as infra', () => {
    expect(classifyCiFailure(zeroStepsJob)).toBe('infra');
  });

  it('classifies a real test failure as non-infra', () => {
    expect(classifyCiFailure(realTestFailureJob)).toBe('non-infra');
  });

  it('classifies a job cancelled mid-run as non-infra', () => {
    const job = {
      ...cancelledBeforeStartJob,
      steps: [
        { status: 'completed', started_at: '2026-10-01T00:00:00Z' },
        { status: 'in_progress', started_at: null },
      ],
    };
    expect(classifyCiFailure(job)).toBe('non-infra');
  });

  it('treats a queued step with a started_at as started', () => {
    const job = { ...cancelledBeforeStartJob, steps: [{ status: 'queued', started_at: '2026-10-01T00:00:00Z' }] };
    expect(classifyCiFailure(job)).toBe('non-infra');
  });

  it('never classifies a passing conclusion as infra', () => {
    expect(classifyCiFailure({ ...noRunnerJob, conclusion: 'success' })).toBe('non-infra');
    expect(classifyCiFailure({ ...noRunnerJob, conclusion: 'skipped' })).toBe('non-infra');
  });

  it('fails closed on missing fields', () => {
    expect(classifyCiFailure({ conclusion: 'failure' })).toBe('non-infra');
    expect(classifyCiFailure({ conclusion: 'cancelled', runner_id: 42, steps: undefined })).toBe('non-infra');
  });

  it('does not treat a named runner as unassigned', () => {
    const job = { ...realTestFailureJob, runner_id: null, runner_name: 'self-hosted-1' };
    expect(classifyCiFailure(job)).toBe('non-infra');
  });
});

describe('watchChecksWithInfraRerun', () => {
  const ids = { run_id: 7, run_attempt: 1, head_sha: 'abc123' };
  const zeroStepsJob = { ...ids, conclusion: 'failure', runner_id: 42, runner_name: 'GitHub Actions 42', steps: [] };
  const noRunnerJob = { ...ids, conclusion: 'failure', runner_id: null, runner_name: null, steps: [] };
  const cancelledBeforeStartJob = {
    ...ids,
    conclusion: 'cancelled',
    runner_id: 42,
    runner_name: 'GitHub Actions 42',
    steps: [{ status: 'queued', started_at: null }],
  };
  const realTestFailureJob = {
    ...ids,
    conclusion: 'failure',
    runner_id: 42,
    runner_name: 'GitHub Actions 42',
    steps: [{ name: 'Run tests', status: 'completed', conclusion: 'failure', started_at: '2026-10-01T00:01:00Z' }],
  };
  const failedRun = (id: number, extra: Record<string, unknown> = {}) => ({
    id,
    head_sha: 'abc123',
    status: 'completed',
    conclusion: 'failure',
    ...extra,
  });

  function setup(opts: {
    outcomes?: Array<'success' | 'failure' | 'timeout'>;
    runs?: any[];
    runsByCall?: any[][];
    listThrowsOnCall?: number;
    jobsByCall?: Array<Record<number, any>>;
    jobs?: Record<number, any>;
    listThrows?: boolean;
    jobThrows?: boolean;
    rerunOk?: boolean;
    budget?: Set<string>;
    useDefaultBudget?: boolean;
  }) {
    const outcomes = opts.outcomes ?? ['failure', 'success'];
    const reruns: string[][] = [];
    const rescues: any[] = [];
    const rescueFailures: any[] = [];
    let watchCalls = 0;
    let listCalls = 0;
    let jobCalls = 0;
    const octokit: any = {
      rest: {
        checks: {
          listForRef: async () => {
            listCalls++;
            if (opts.listThrows || opts.listThrowsOnCall === listCalls) throw new Error('list boom');
            const runs = opts.runsByCall?.[listCalls - 1] ?? opts.runs ?? [failedRun(1)];
            return { data: { check_runs: runs } };
          },
        },
        actions: {
          getJobForWorkflowRun: async ({ job_id }: any) => {
            if (opts.jobThrows) throw new Error('404');
            const jobs = opts.jobsByCall?.[jobCalls++] ?? opts.jobs ?? { 1: zeroStepsJob };
            return { data: jobs[job_id] };
          },
        },
      },
    };
    const call = (extra: Record<string, unknown> = {}) =>
      watchChecksWithInfraRerun({
        octokit,
        owner: 'o',
        repo: 'r',
        ref: 'abc123',
        watch: async () => outcomes[Math.min(watchCalls++, outcomes.length - 1)],
        rerun: async (argv) => {
          reruns.push([...argv]);
          return { ok: opts.rerunOk ?? true };
        },
        ...(opts.useDefaultBudget ? {} : { rerunBudget: opts.budget ?? new Set<string>() }),
        sleep: async () => {},
        onRescued: (r) => rescues.push(r),
        onRescueFailed: (f) => rescueFailures.push(f),
        ...extra,
      });
    return { call, reruns, rescues, rescueFailures, watchCalls: () => watchCalls, listCalls: () => listCalls };
  }

  it('reruns a zero-steps infra failure once and reports ci-rescued when the re-watch is green', async () => {
    const t = setup({});
    expect(await t.call()).toBe('success');
    expect(t.reruns).toEqual([['gh', 'run', 'rerun', '7', '--failed', '--repo', 'o/r']]);
    expect(t.rescues).toEqual([{ headSha: 'abc123', runIds: [7] }]);
    expect(t.watchCalls()).toBe(2);
  });

  it('reruns a no-runner-assigned infra failure once', async () => {
    const t = setup({ jobs: { 1: noRunnerJob } });
    await t.call();
    expect(t.reruns).toHaveLength(1);
  });

  it('reruns a job cancelled before start once', async () => {
    const t = setup({ jobs: { 1: cancelledBeforeStartJob } });
    await t.call();
    expect(t.reruns).toHaveLength(1);
  });

  it('does not rerun a real test failure', async () => {
    const t = setup({ jobs: { 1: realTestFailureJob } });
    expect(await t.call()).toBe('failure');
    expect(t.reruns).toHaveLength(0);
    expect(t.rescues).toHaveLength(0);
    expect(t.watchCalls()).toBe(1);
  });

  it('never reruns the same head SHA twice', async () => {
    const t = setup({ outcomes: ['failure', 'failure', 'failure'] });
    const budget = new Set<string>();
    expect(await t.call({ rerunBudget: budget })).toBe('infra-failure');
    expect(await t.call({ rerunBudget: budget })).toBe('failure');
    expect(t.reruns).toHaveLength(1);
    expect(t.rescueFailures).toHaveLength(1);
    expect(t.watchCalls()).toBe(3);
  });

  it('does not rerun a job already on run_attempt 2', async () => {
    const t = setup({ jobs: { 1: { ...zeroStepsJob, run_attempt: 2 } } });
    expect(await t.call()).toBe('failure');
    expect(t.reruns).toHaveLength(0);
    expect(t.rescueFailures).toHaveLength(0);
  });

  it('returns infra-failure and reports ci-rescue-failed when the rerun also fails for infra on the same SHA', async () => {
    const t = setup({ outcomes: ['failure', 'failure'] });
    expect(await t.call()).toBe('infra-failure');
    expect(t.reruns).toHaveLength(1);
    expect(t.rescueFailures).toEqual([{ headSha: 'abc123', runIds: [7], outcome: 'infra-failure' }]);
    expect(t.rescues).toHaveLength(0);
    expect(t.watchCalls()).toBe(2);
  });

  it('returns failure when the post-rerun failure is on a different head SHA', async () => {
    const t = setup({
      outcomes: ['failure', 'failure'],
      runsByCall: [[failedRun(1)], [failedRun(1, { head_sha: 'def456' })]],
    });
    expect(await t.call()).toBe('failure');
    expect(t.rescueFailures[0].outcome).toBe('failure');
    expect(t.reruns).toHaveLength(1);
  });

  it('returns failure when the post-rerun failure includes a real test failure', async () => {
    const t = setup({
      outcomes: ['failure', 'failure'],
      jobsByCall: [{ 1: zeroStepsJob }, { 1: realTestFailureJob }],
    });
    expect(await t.call()).toBe('failure');
    expect(t.rescueFailures).toEqual([{ headSha: 'abc123', runIds: [7], outcome: 'failure' }]);
    expect(t.reruns).toHaveLength(1);
  });

  it('passes a post-rerun timeout through and reports it', async () => {
    const t = setup({ outcomes: ['failure', 'timeout'] });
    expect(await t.call()).toBe('timeout');
    expect(t.rescueFailures).toEqual([{ headSha: 'abc123', runIds: [7], outcome: 'timeout' }]);
  });

  it('returns failure and reports once when the post-rerun re-list throws', async () => {
    const t = setup({ outcomes: ['failure', 'failure'], listThrowsOnCall: 2 });
    expect(await t.call()).toBe('failure');
    expect(t.rescueFailures).toEqual([{ headSha: 'abc123', runIds: [7], outcome: 'failure' }]);
  });

  it('does not rerun a mixed infra + real failure', async () => {
    const t = setup({ runs: [failedRun(1), failedRun(2)], jobs: { 1: zeroStepsJob, 2: realTestFailureJob } });
    expect(await t.call()).toBe('failure');
    expect(t.reruns).toHaveLength(0);
  });

  it('passes success and timeout through without listing check runs', async () => {
    for (const outcome of ['success', 'timeout'] as const) {
      const t = setup({ outcomes: [outcome] });
      expect(await t.call()).toBe(outcome);
      expect(t.listCalls()).toBe(0);
    }
  });

  describe('fails closed with no rerun', () => {
    const cases: Array<[string, Parameters<typeof setup>[0]]> = [
      ['listForRef throws', { listThrows: true }],
      ['getJobForWorkflowRun throws', { jobThrows: true }],
      ['no failed run in the re-list', { runs: [{ id: 1, status: 'completed', conclusion: 'success' }] }],
      ['a failed run has no id', { runs: [{ head_sha: 'abc123', status: 'completed', conclusion: 'failure' }] }],
      [
        'no head_sha anywhere',
        { runs: [failedRun(1, { head_sha: undefined })], jobs: { 1: { ...zeroStepsJob, head_sha: undefined } } },
      ],
      ['job has no run_id', { jobs: { 1: { ...zeroStepsJob, run_id: undefined } } }],
    ];
    for (const [name, o] of cases) {
      it(name, async () => {
        const t = setup(o);
        expect(await t.call()).toBe('failure');
        expect(t.reruns).toHaveLength(0);
        expect(t.rescueFailures).toHaveLength(0);
      });
    }

    it('rerun returns ok false (the SHA stays in the budget)', async () => {
      const budget = new Set<string>();
      const t = setup({ rerunOk: false, budget });
      expect(await t.call()).toBe('failure');
      expect(t.reruns).toHaveLength(1);
      expect(budget.has('abc123')).toBe(true);
      expect(t.watchCalls()).toBe(1);
      expect(t.rescueFailures).toEqual([{ headSha: 'abc123', runIds: [7], outcome: 'failure' }]);
    });
  });

  it('falls back to the job head_sha when the check run has none', async () => {
    const t = setup({ runs: [failedRun(1, { head_sha: undefined })] });
    expect(await t.call()).toBe('success');
    expect(t.rescues[0].headSha).toBe('abc123');
  });

  it('dedupes two infra jobs in the same run to one rerun call', async () => {
    const t = setup({ runs: [failedRun(1), failedRun(2)], jobs: { 1: zeroStepsJob, 2: noRunnerJob } });
    await t.call();
    expect(t.reruns).toHaveLength(1);
  });

  it('reruns each distinct failed run', async () => {
    const t = setup({
      runs: [failedRun(1), failedRun(2)],
      jobs: { 1: zeroStepsJob, 2: { ...noRunnerJob, run_id: 8 } },
    });
    await t.call();
    expect(t.reruns.map((a) => a[3])).toEqual(['7', '8']);
  });

  it('uses the shared default budget when none is passed', async () => {
    const sha = 'unique-default-budget-sha';
    const jobs = { 1: { ...zeroStepsJob, head_sha: sha } };
    const runs = [failedRun(1, { head_sha: sha })];
    const t = setup({ jobs, runs, useDefaultBudget: true, outcomes: ['failure', 'failure', 'failure'] });
    await t.call();
    await t.call();
    expect(t.reruns).toHaveLength(1);
  });
});

describe('watchChecks no-checks early exit and progress (#2386)', () => {
  const base = { owner: 'on-par', repo: 'software-factory', ref: 'ship-it/123-ci-poll' };

  it('returns no-checks after the grace period when there are no check runs and no commit statuses', async () => {
    const { listForRef } = scriptChecks([[]]);
    const { now, sleep } = createClock();
    const getCombinedStatusForRef = vi.fn(async () => {
      expect(now()).toBeGreaterThanOrEqual(90_000);
      return { data: { total_count: 0, statuses: [], sha: 'abc123' } };
    });
    const onNoChecks = vi.fn();
    const octokit = { rest: { checks: { listForRef }, repos: { getCombinedStatusForRef } } };

    const outcome = await watchChecks({
      ...base,
      octokit: octokit as any,
      noChecksGraceMs: 90_000,
      onNoChecks,
      sleep,
      now,
    });

    expect(outcome).toBe('no-checks');
    expect(onNoChecks).toHaveBeenCalledTimes(1);
    expect(onNoChecks.mock.calls[0][0]).toMatchObject({ sha: 'abc123' });
    expect(now()).toBeGreaterThanOrEqual(90_000);
    expect(now()).toBeLessThanOrEqual(90_000 + 60_000);
    expect(getCombinedStatusForRef).toHaveBeenCalledTimes(1);
  });

  it('keeps watching when commit statuses exist even with zero check runs', async () => {
    const { listForRef } = scriptChecks([[]]);
    const { now, sleep } = createClock();
    const getCombinedStatusForRef = vi.fn(async () => ({ data: { total_count: 1, statuses: [{}], sha: 'abc123' } }));
    const octokit = { rest: { checks: { listForRef }, repos: { getCombinedStatusForRef } } };

    const outcome = await watchChecks({ ...base, octokit: octokit as any, noChecksGraceMs: 90_000, sleep, now });

    expect(outcome).toBe('timeout');
    expect(getCombinedStatusForRef).toHaveBeenCalled();
  });

  it('keeps watching when the combined-status call throws', async () => {
    const { listForRef } = scriptChecks([[]]);
    const { now, sleep } = createClock();
    const getCombinedStatusForRef = vi.fn(async () => {
      throw new Error('boom');
    });
    const octokit = { rest: { checks: { listForRef }, repos: { getCombinedStatusForRef } } };

    const outcome = await watchChecks({ ...base, octokit: octokit as any, noChecksGraceMs: 90_000, sleep, now });

    expect(outcome).toBe('timeout');
    expect(now()).toBeGreaterThanOrEqual(600_000);
    expect(getCombinedStatusForRef.mock.calls.length).toBeGreaterThan(3);
  });

  it('never checks statuses or returns no-checks when noChecksGraceMs is unset', async () => {
    const { listForRef } = scriptChecks([[]]);
    const { now, sleep } = createClock();
    const getCombinedStatusForRef = vi.fn(async () => ({ data: { total_count: 0, statuses: [], sha: 'abc123' } }));
    const octokit = { rest: { checks: { listForRef }, repos: { getCombinedStatusForRef } } };

    const outcome = await watchChecks({ ...base, octokit: octokit as any, sleep, now });

    expect(outcome).toBe('timeout');
    expect(getCombinedStatusForRef).not.toHaveBeenCalled();
  });

  it('reports progress at most once per progressIntervalMs with remaining time while checks are pending', async () => {
    const { listForRef } = scriptChecks([pending]);
    const { now, sleep } = createClock();
    const octokit = { rest: { checks: { listForRef } } };
    const seen: Array<{ total: number; completed: number; pending: number; elapsedMs: number; remainingMs: number }> =
      [];

    const outcome = await watchChecks({
      ...base,
      octokit: octokit as any,
      onProgress: (p) => seen.push(p),
      sleep,
      now,
    });

    expect(outcome).toBe('timeout');
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.length).toBeLessThanOrEqual(11);
    for (const p of seen) {
      expect(p).toMatchObject({ total: 1, completed: 0, pending: 1 });
      expect(p.remainingMs).toBe(600_000 - p.elapsedMs);
    }
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i].elapsedMs - seen[i - 1].elapsedMs).toBeGreaterThanOrEqual(60_000);
      expect(seen[i].remainingMs).toBeLessThan(seen[i - 1].remainingMs);
    }
  });

  it('does not report progress when there are no check runs', async () => {
    const { listForRef } = scriptChecks([[]]);
    const { now, sleep } = createClock();
    const onProgress = vi.fn();
    const octokit = { rest: { checks: { listForRef } } };

    await watchChecks({ ...base, octokit: octokit as any, onProgress, sleep, now });

    expect(onProgress).not.toHaveBeenCalled();
  });
});

describe('resolveCiNoChecksGraceMs', () => {
  it('defaults to 90s, honors a valid override, and falls back on invalid values', () => {
    expect(resolveCiNoChecksGraceMs({})).toBe(DEFAULT_CI_NO_CHECKS_GRACE_MS);
    expect(resolveCiNoChecksGraceMs({ FACTORY_CI_NO_CHECKS_GRACE_SECONDS: '30' })).toBe(30_000);
    expect(resolveCiNoChecksGraceMs({ FACTORY_CI_NO_CHECKS_GRACE_SECONDS: '0' })).toBe(0);
    for (const bad of ['abc', '-5', '']) {
      expect(resolveCiNoChecksGraceMs({ FACTORY_CI_NO_CHECKS_GRACE_SECONDS: bad })).toBe(90_000);
    }
  });
});

describe('watchChecksWithInfraRerun no-checks (#2386)', () => {
  it('passes no-checks through without listing failed runs or rerunning', async () => {
    const listForRef = vi.fn(async () => ({ data: { check_runs: [] } }));
    const rerun = vi.fn(async () => ({ ok: true }));
    const watch = vi.fn(async () => 'no-checks' as const);

    const outcome = await watchChecksWithInfraRerun({
      octokit: { rest: { checks: { listForRef } } } as any,
      owner: 'on-par',
      repo: 'software-factory',
      ref: 'ship-it/123-ci-poll',
      watch,
      rerun,
      rerunBudget: new Set(),
    });

    expect(outcome).toBe('no-checks');
    expect(watch).toHaveBeenCalledTimes(1);
    expect(listForRef).not.toHaveBeenCalled();
    expect(rerun).not.toHaveBeenCalled();
  });
});
