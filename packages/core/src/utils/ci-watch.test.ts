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
});
