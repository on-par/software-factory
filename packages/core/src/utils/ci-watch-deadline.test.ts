// packages/core/src/utils/ci-watch-deadline.test.ts — watchChecks onDeadline / onNoRequiredChecks and the no-required-checks verdict (#3208)

import { describe, expect, it, vi } from 'vitest';

import { watchChecks } from './ci-watch.js';

const base = { owner: 'on-par', repo: 'software-factory', ref: 'abc123', deadlineMs: 60_000 };

function clock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

function fakeOctokit(sequence: any[][], statusTotal: number | 'error' = 0) {
  let i = 0;
  const getCombinedStatusForRef = vi.fn(async () => {
    if (statusTotal === 'error') throw new Error('boom');
    return { data: { total_count: statusTotal, statuses: [], sha: 'abc123' } };
  });
  const listForRef = vi.fn(async () => ({ data: { check_runs: sequence[Math.min(i++, sequence.length - 1)] } }));
  return {
    octokit: { rest: { checks: { listForRef }, repos: { getCombinedStatusForRef } } } as any,
    listForRef,
    getCombinedStatusForRef,
  };
}

describe('watchChecks onDeadline (#3208)', () => {
  it('reports neverStarted at the deadline when no run and no status ever registered', async () => {
    const { octokit } = fakeOctokit([[]]);
    const onDeadline = vi.fn();
    expect(await watchChecks({ ...base, octokit, onDeadline, ...clock() })).toBe('timeout');
    expect(onDeadline).toHaveBeenCalledExactlyOnceWith({ neverStarted: true });
  });

  it('reports neverStarted false when a commit status exists', async () => {
    const { octokit } = fakeOctokit([[]], 1);
    const onDeadline = vi.fn();
    await watchChecks({ ...base, octokit, onDeadline, ...clock() });
    expect(onDeadline).toHaveBeenCalledWith({ neverStarted: false });
  });

  it('reports neverStarted false (fail closed) when the status lookup fails', async () => {
    const { octokit } = fakeOctokit([[]], 'error');
    const onDeadline = vi.fn();
    await watchChecks({ ...base, octokit, onDeadline, ...clock() });
    expect(onDeadline).toHaveBeenCalledWith({ neverStarted: false });
  });

  it('reports neverStarted false when check runs were seen, without asking for statuses', async () => {
    const { octokit, getCombinedStatusForRef } = fakeOctokit([
      [{ name: 'lint', status: 'in_progress', conclusion: null }],
    ]);
    const onDeadline = vi.fn();
    await watchChecks({ ...base, octokit, onDeadline, ...clock() });
    expect(onDeadline).toHaveBeenCalledWith({ neverStarted: false });
    expect(getCombinedStatusForRef).not.toHaveBeenCalled();
  });

  it('does not call onDeadline when repeated poll errors end the watch early', async () => {
    const octokit: any = { rest: { checks: { listForRef: async () => Promise.reject(new Error('down')) } } };
    const onDeadline = vi.fn();
    expect(await watchChecks({ ...base, octokit, onDeadline, ...clock() })).toBe('timeout');
    expect(onDeadline).not.toHaveBeenCalled();
  });
});

describe('watchChecks with no required checks (#3208)', () => {
  const lint = { name: 'lint', status: 'completed', conclusion: 'success' };

  it('calls onNoRequiredChecks once and gates on every check run: pending, then green after the set settles', async () => {
    const { octokit, listForRef } = fakeOctokit([
      [lint, { name: 'test', status: 'in_progress', conclusion: null }],
      [lint, { name: 'test', status: 'completed', conclusion: 'success' }],
    ]);
    const onNoRequiredChecks = vi.fn();
    const outcome = await watchChecks({
      ...base,
      octokit,
      requiredChecks: { branch: 'main' },
      onNoRequiredChecks,
      ...clock(),
    });
    expect(outcome).toBe('success');
    expect(onNoRequiredChecks).toHaveBeenCalledExactlyOnceWith({ branch: 'main' });
    expect(listForRef.mock.calls.length).toBeGreaterThan(2);
  });

  it('fails when a completed run is red, and stays quiet without a branch', async () => {
    const { octokit } = fakeOctokit([[lint, { name: 'test', status: 'completed', conclusion: 'failure' }]]);
    const onNoRequiredChecks = vi.fn();
    expect(await watchChecks({ ...base, octokit, onNoRequiredChecks, ...clock() })).toBe('failure');
    expect(onNoRequiredChecks).not.toHaveBeenCalled();
  });
});
