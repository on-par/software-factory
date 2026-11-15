import { describe, expect, it, vi } from 'vitest';

import { recordArgs } from '../test-support/recorders.js';
import { hasAnyCiSignal, watchChecks } from './ci-watch.js';

const statuses = (total: number) => vi.fn(async () => ({ data: { total_count: total, statuses: [], sha: 'abc' } }));
const runs = (check_runs: unknown[]) => vi.fn(async () => ({ data: { check_runs } }));
const base = { owner: 'o', repo: 'r', ref: 'abc' };

describe('hasAnyCiSignal (#3208)', () => {
  it('is true when a check run exists, without reading statuses', async () => {
    const reads = recordArgs(statuses(0));
    const checks = { listForRef: runs([{ name: 'x' }]) };
    const octokit = { rest: { checks, repos: { getCombinedStatusForRef: reads.fn } } };
    expect(await hasAnyCiSignal(octokit as any, 'o', 'r', 'abc')).toBe(true);
    expect(reads.calls).toEqual([]);
  });

  it('is true when only a commit status exists', async () => {
    const octokit = { rest: { checks: { listForRef: runs([]) }, repos: { getCombinedStatusForRef: statuses(2) } } };
    expect(await hasAnyCiSignal(octokit as any, 'o', 'r', 'abc')).toBe(true);
  });

  it('is false only when there are no runs and no statuses', async () => {
    const octokit = { rest: { checks: { listForRef: runs([]) }, repos: { getCombinedStatusForRef: statuses(0) } } };
    expect(await hasAnyCiSignal(octokit as any, 'o', 'r', 'abc')).toBe(false);
  });

  it('is undefined when either lookup fails', async () => {
    const boom = vi.fn(async () => {
      throw new Error('api down');
    });
    const noRuns = { rest: { checks: { listForRef: boom }, repos: { getCombinedStatusForRef: statuses(0) } } };
    expect(await hasAnyCiSignal(noRuns as any, 'o', 'r', 'abc')).toBeUndefined();
    const noStatus = { rest: { checks: { listForRef: runs([]) }, repos: { getCombinedStatusForRef: boom } } };
    expect(await hasAnyCiSignal(noStatus as any, 'o', 'r', 'abc')).toBeUndefined();
  });
});

describe('watchChecks onNoRequiredChecks (#3208)', () => {
  const watch = async (contexts: string[], onNoRequiredChecks: (i: { branch: string }) => void) => {
    let clock = 0;
    const octokit = {
      rest: {
        checks: { listForRef: runs([{ name: 'lint', status: 'completed', conclusion: 'success' }]) },
        repos: {
          getStatusChecksProtection: vi.fn(async () => ({ data: { contexts, checks: [] } })),
          getBranchRules: vi.fn(async () => ({ data: [] })),
          getCombinedStatusForRef: statuses(0),
        },
      },
    };
    return watchChecks({
      ...base,
      octokit: octokit as any,
      requiredChecks: { branch: 'main' },
      minChecks: 1,
      onNoRequiredChecks,
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    });
  };

  it('fires once when the branch has no required contexts', async () => {
    const seen: Array<{ branch: string }> = [];
    expect(await watch([], (i) => void seen.push(i))).toBe('success');
    expect(seen).toEqual([{ branch: 'main' }]);
  });

  it('does not fire when contexts are required, and a throwing callback is swallowed', async () => {
    const seen: Array<{ branch: string }> = [];
    await watch(['lint'], (i) => void seen.push(i));
    expect(seen).toEqual([]);
    expect(
      await watch([], () => {
        throw new Error('boom');
      }),
    ).toBe('success');
  });
});
