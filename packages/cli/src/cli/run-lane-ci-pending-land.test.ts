import { getFactoryPaths } from '@on-par/factory-core';
import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { waitForMerge } from './land.js';
import { AwaitMergeStoppedError } from './land-pr.js';
import { CiUnverifiedError } from './land-errors.js';
import type { RunLaneDeps } from './run-lane-deps.js';
import { runLane } from './run-lane.js';

const dirs = createTempDirs();
afterEach(() => dirs.cleanup());

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

function setup() {
  const dir = dirs.makeSync('lane-ci-pending-land-');
  const paths = getFactoryPaths(dir);
  const calls: any[] = [];
  const events: Array<[string, string]> = [];
  const ship = vi.fn(async (_issue: number, _o: unknown, c: any) => {
    c.onOutcome({
      state: 'ready',
      route: 'claude',
      branch: 'b',
      reworkRounds: 0,
      prNumber: 7,
      draft: true,
      draftReason: 'ci-pending',
    });
    return 'ship-it/1-x';
  });
  const waitMerge = vi.fn(async (issue: number, branch: string) => {
    calls.push(['waitMerge', issue, branch]);
  });
  const closeParkedPr = vi.fn(async () => {});
  const reapWorktree = vi.fn(async () => {});
  const base: RunLaneDeps = {
    ship: ship as any,
    waitMerge: waitMerge as any,
    pathExists: () => false,
    releaseIssue: async (issue, outcome) => {
      calls.push(['release', issue, outcome]);
    },
    closeParkedPr,
    reapWorktree,
    sweepFinished: async () => {},
    emitEvent: (_f: string, type: string, _i: string | number, msg: string) => {
      events.push([type, msg]);
    },
  };
  return { paths, calls, events, ship, waitMerge, closeParkedPr, reapWorktree, base };
}

const adoptClaims = (branch = 'factory/5-x') => {
  const claims = [{ issue: 5, decision: { kind: 'adopt' as const, branch } }];
  return async () => claims.shift() ?? null;
};

describe('runLane CI-pending draft landing (#3968)', () => {
  it('a CI-pending draft with auto-merge on enters the land path and settles done only after the merge', async () => {
    const s = setup();
    await runLane('app', [1], '/repo', 'o/r', s.paths, { ...s.base, mergeEnabled: () => true });
    expect(s.ship).toHaveBeenCalledTimes(1);
    expect(s.waitMerge).toHaveBeenCalledTimes(1);
    expect(s.calls).toEqual([
      ['waitMerge', 1, 'ship-it/1-x'],
      ['release', 1, 'done'],
    ]);
    expect(s.events.some(([t, m]) => t === 'ship' && m.includes('landing it'))).toBe(true);
    expect(s.events.some(([, m]) => m.includes('merge skipped'))).toBe(false);
    expect(s.events.find(([t]) => t === 'lane-done')?.[1]).toContain('1 merged');
  });

  it('a CI-pending draft lands through waitForMerge which flips it ready and merges without a second ship', async () => {
    const s = setup();
    const land = vi.fn(async () => {});
    await runLane('app', [1], '/repo', 'o/r', s.paths, {
      ...s.base,
      mergeEnabled: () => true,
      // The ready flip is owned by landOpenPullRequest and covered by the land-pr tests.
      waitMerge: (issue, branch, root, gh, p, d = {}) =>
        waitForMerge(issue, branch, root, gh, p, {
          ...d,
          createOctokit: () => ({}) as any,
          loadConfig: () => fakeConfig,
          mergeEnabled: () => true,
          checkMerged: async () => false,
          listIssueLabels: async () => [],
          land: land as any,
          pathExists: () => false,
          emitEvent: () => {},
        }),
    });
    expect(land).toHaveBeenCalledTimes(1);
    const args = land.mock.calls[0] as any[];
    expect(args[0]).toBe(1);
    expect(args[7]).toMatchObject({ enforceRisk: true, rebuildOnConflict: true });
    expect(args[7]).not.toHaveProperty('syncMain');
    expect(s.ship).toHaveBeenCalledTimes(1);
  });

  it('an adopted CI-pending draft lands without calling ship', async () => {
    const s = setup();
    await runLane('app', [], '/repo', 'o/r', s.paths, { ...s.base, claimNext: adoptClaims() });
    expect(s.ship).not.toHaveBeenCalled();
    expect(s.calls).toEqual([
      ['waitMerge', 5, 'factory/5-x'],
      ['release', 5, 'done'],
    ]);
  });

  it('a CI-pending draft labelled no-auto-merge never calls land and is re-queued on STOP', async () => {
    const s = setup();
    let stopped = false;
    const land = vi.fn(async () => {});
    await runLane('app', [1], '/repo', 'o/r', s.paths, {
      ...s.base,
      mergeEnabled: () => true,
      waitMerge: (issue, branch, root, gh, p, d = {}) =>
        waitForMerge(issue, branch, root, gh, p, {
          ...d,
          createOctokit: () => ({}) as any,
          loadConfig: () => fakeConfig,
          mergeEnabled: () => true,
          checkMerged: async () => false,
          listIssueLabels: async () => ['no-auto-merge'],
          lookupPr: async () => ({ number: 7, merged: false }) as any,
          land: land as any,
          sleep: async () => {
            stopped = true;
          },
          pathExists: (path) => path === s.paths.stop && stopped,
          emitEvent: (_f: string, type: string, _i: string | number, msg: string) => {
            s.events.push([type, msg]);
          },
        }),
    });
    expect(land).not.toHaveBeenCalled();
    expect(s.events.some(([t]) => t === 'merge-gated')).toBe(true);
    expect(s.calls).toContainEqual(['release', 1, 'queued']);
  });

  it('a CI-pending draft with auto-merge off keeps settling done without a merge wait', async () => {
    const s = setup();
    await runLane('app', [1], '/repo', 'o/r', s.paths, { ...s.base, mergeEnabled: () => false });
    expect(s.waitMerge).not.toHaveBeenCalled();
    expect(s.calls).toEqual([['release', 1, 'done']]);
    expect(s.events.some(([, m]) => m.includes('CI pending; the between-issue sweep'))).toBe(true);
  });

  it('a CI-pending draft whose land CI stays unverified parks ci-failed, closes the PR and reaps the worktree', async () => {
    const s = setup();
    s.waitMerge.mockRejectedValueOnce(new CiUnverifiedError('CI timed out', 7));
    await runLane('app', [1], '/repo', 'o/r', s.paths, { ...s.base, mergeEnabled: () => true });
    expect(s.closeParkedPr).toHaveBeenCalledWith(1, 'ship-it/1-x', 'ci-failed');
    expect(s.reapWorktree).toHaveBeenCalledWith(1);
    expect(s.calls).toContainEqual(['release', 1, 'parked']);
    expect(s.events.some(([t]) => t === 'parked')).toBe(true);
  });

  it('an adopted CI-pending draft stopped during the merge wait is released queued', async () => {
    const s = setup();
    s.waitMerge.mockRejectedValueOnce(new AwaitMergeStoppedError('STOP', 'factory/5-x', 7));
    await runLane('app', [], '/repo', 'o/r', s.paths, { ...s.base, claimNext: adoptClaims() });
    expect(s.calls).toContainEqual(['release', 5, 'queued']);
    expect(s.calls.some((c) => c[0] === 'release' && c[2] === 'parked')).toBe(false);
    expect(s.reapWorktree).not.toHaveBeenCalled();
    expect(s.closeParkedPr).not.toHaveBeenCalled();
  });
});
