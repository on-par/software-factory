// packages/cli/src/cli/land-stop.test.ts — waitForMerge when STOP ends the wait (#3291)

import { describe, expect, it, vi } from 'vitest';

import './index.js';
import { latestPrForBranch, waitForMerge } from './land.js';
import { AwaitMergeStoppedError } from './land-pr.js';

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

describe('waitForMerge STOP exit (#3291)', () => {
  const run = (lookupPr: any, events: any[]) =>
    waitForMerge(7, 'ship-it/7-x', '/repo', 'on-par/software-factory', { events: '/e', stop: '/STOP' } as any, {
      createOctokit: () => ({}) as any,
      pathExists: () => true,
      loadConfig: () => fakeConfig,
      mergeEnabled: () => true,
      lookupPr,
      land: async () => {
        throw new Error('land should not be called');
      },
      emitEvent: (_f: string, type: string, _i: string | number, msg: string) => events.push([type, msg]),
    });

  it('rejects with AwaitMergeStoppedError carrying PR #12 when STOP is present and the PR is open', async () => {
    const events: any[] = [];
    const err = await run(async () => ({ number: 12, merged: false }), events).catch((e) => e);
    expect(err).toBeInstanceOf(AwaitMergeStoppedError);
    expect(err.prNumber).toBe(12);
    expect(err.branch).toBe('ship-it/7-x');
    expect(events.some((e) => e[0] === 'landed')).toBe(false);
  });

  it('waitForMerge with STOP present emits landed when the PR is already merged (#3291)', async () => {
    const events: any[] = [];
    await run(async () => ({ number: 12, merged: true }), events);
    expect(events).toContainEqual(['landed', 'PR merged']);
  });

  it('rejects with prNumber null when the lookup throws', async () => {
    const err = await run(async () => {
      throw new Error('boom');
    }, []).catch((e) => e);
    expect(err).toBeInstanceOf(AwaitMergeStoppedError);
    expect(err.prNumber).toBeNull();
  });

  it('latestPrForBranch returns the highest-numbered PR, or null when none', async () => {
    const list = vi.fn(async () => ({
      data: [
        { number: 3, merged_at: '2026-01-01' },
        { number: 9, merged_at: null },
      ],
    }));
    const octokit = { rest: { pulls: { list } } } as any;
    expect(await latestPrForBranch(octokit, 'o', 'r', 'b')).toEqual({ number: 9, merged: false });
    list.mockResolvedValueOnce({ data: [] });
    expect(await latestPrForBranch(octokit, 'o', 'r', 'b')).toBeNull();
  });
});
