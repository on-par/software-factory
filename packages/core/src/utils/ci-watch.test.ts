import { describe, expect, it } from 'vitest';

import { watchChecks } from './ci-watch.js';

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
