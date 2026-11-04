// packages/cli/src/cli/land.merge-hold.test.ts — waitForMerge opt-ins for run-issue --merge (#3905)

import { describe, expect, it, vi } from 'vitest';

import './index.js';
import { waitForMerge } from './land.js';
import { MergeGatedError } from './land-pr.js';

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

function run(extra: Record<string, unknown>, events: any[] = []) {
  return waitForMerge(7, 'ship-it/7-x', '/repo', 'on-par/software-factory', { events: '/e', stop: '/STOP' } as any, {
    createOctokit: () => ({}) as any,
    pathExists: () => false,
    loadConfig: () => fakeConfig,
    mergeEnabled: () => true,
    checkMerged: async () => false,
    emitEvent: (_f: string, type: string, _i: string | number, msg: string) => events.push([type, msg]),
    writeLine: () => {},
    ...extra,
  });
}

describe('waitForMerge merge-hold opt-ins (#3905)', () => {
  it('holdWhenGated throws MergeGatedError instead of polling', async () => {
    const events: any[] = [];
    const sleep = vi.fn(async () => {});
    const land = vi.fn();
    const err = await run(
      {
        holdWhenGated: true,
        listIssueLabels: async () => ['no-auto-merge'],
        lookupPr: async () => ({ number: 42, merged: false }),
        sleep,
        land,
      },
      events,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(MergeGatedError);
    expect(err.label).toBe('no-auto-merge');
    expect(err.prNumber).toBe(42);
    expect(sleep).not.toHaveBeenCalled();
    expect(land).not.toHaveBeenCalled();
    expect(events.map((e) => e[0])).toContain('merge-gated');
  });

  it('holdWhenGated reports PR 0 when the lookup fails', async () => {
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

  it('without holdWhenGated a gated label still polls (default unchanged)', async () => {
    const sleep = vi.fn(async () => {
      throw new Error('stop-polling');
    });
    await expect(run({ listIssueLabels: async () => ['no-auto-merge'], sleep, land: vi.fn() })).rejects.toThrow(
      'stop-polling',
    );
    expect(sleep).toHaveBeenCalledWith(120_000);
  });

  it('forwards mergeOverrides admin into landIssue', async () => {
    const land = vi.fn(async () => ({ branch: 'ship-it/7-x', prNumber: 1 }));
    await run({ listIssueLabels: async () => [], land, mergeOverrides: { auto: true, admin: true } });
    expect(land.mock.calls[0]?.[7]).toMatchObject({ mergeOverrides: { auto: true, admin: true }, enforceRisk: true });
  });

  it('issueless reads labels from the PR, forwards issueless and skips the claim release', async () => {
    const land = vi.fn(async () => ({ branch: 'ship-it/7-x', prNumber: 1 }));
    const listIssueLabels = vi.fn(async () => []);
    await run({
      issueless: true,
      landBranch: 'ship-it/7-x',
      lookupPr: async () => ({ number: 42, merged: false }),
      listIssueLabels,
      land,
    });
    expect(listIssueLabels).toHaveBeenCalledWith(expect.anything(), 'on-par', 'software-factory', 42);
    expect(land.mock.calls[0]?.[7]).toMatchObject({ issueless: true, branch: 'ship-it/7-x' });
  });
});
