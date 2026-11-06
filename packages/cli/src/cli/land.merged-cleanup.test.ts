// packages/cli/src/cli/land.merged-cleanup.test.ts — a PR merged during the merge wait releases the claim and removes the worktree (#3966)
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LaneFileGuard, workKeyFromIssue } from '@on-par/factory-core';

import './index.js';
import { waitForMerge } from './land.js';
import { cleanupMergedLane } from './land-merged-cleanup.js';
import { landRuntime, setLandRuntime, type LandRuntime } from './land-runtime.js';

const REPO = 'on-par/software-factory';
const REPO_ROOT = '/repo';
const config: any = {
  sandbox: { enabled: false },
  merge: { auto: true, comment: '' },
  filing: { enabled: false, selfFixLabel: 'no-auto-merge' },
};

let root = '';
let guard: LaneFileGuard;
let paths: any;
let previous: (() => LandRuntime) | undefined;
const cleanupWorktree = vi.fn(async (..._args: unknown[]) => {});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'merged-cleanup-'));
  const laneFiles = join(root, 'lane-files.json');
  guard = new LaneFileGuard(laneFiles);
  await guard.register(REPO, workKeyFromIssue(1), ['src/a.ts']);
  paths = {
    events: join(root, 'events.ndjson'),
    stop: join(root, 'STOP'),
    runs: join(root, 'runs'),
    laneFiles,
    landSlotLock: join(root, 'land-slot.lock'),
    mergeLock: join(root, 'merge.lock'),
    gitLock: join(root, 'git.lock'),
    state: root,
  };
  cleanupWorktree.mockClear();
  cleanupWorktree.mockImplementation(async () => {});
  const base = landRuntime();
  previous = setLandRuntime(() => {
    const rt = base;
    return {
      ...rt,
      gitOps: { ...rt.gitOps, cleanupWorktree },
      configLoaders: { ...rt.configLoaders, loadRepoConfig: () => ({}) as any },
    };
  });
});

afterEach(async () => {
  if (previous) setLandRuntime(previous);
  await rm(root, { recursive: true, force: true });
});

function expectedWorktree(): string {
  return landRuntime().worktreePathFor(REPO_ROOT, REPO, 1, 'factory');
}

describe('waitForMerge merged exits clean up the lane (#3966)', () => {
  it('waitForMerge already-merged poll releases the claim and calls cleanupWorktree', async () => {
    const events: Array<[string, string]> = [];
    await waitForMerge(1, 'factory/1-x', REPO_ROOT, REPO, paths, {
      createOctokit: () => ({}) as any,
      pathExists: () => false,
      checkMerged: async () => true,
      loadConfig: () => config,
      emitEvent: ((_f: string, type: string, _i: number, msg: string) => events.push([type, msg])) as any,
    });
    expect(await guard.claimsForIssue(workKeyFromIssue(1))).toEqual([]);
    expect(cleanupWorktree).toHaveBeenCalledTimes(1);
    expect(cleanupWorktree.mock.calls[0]?.slice(0, 2)).toEqual([REPO_ROOT, expectedWorktree()]);
    expect(events).toContainEqual(['landed', 'PR merged']);
  });

  it('waitForMerge STOP with a merged PR releases the claim and calls cleanupWorktree', async () => {
    const events: Array<[string, string]> = [];
    await waitForMerge(1, 'factory/1-x', REPO_ROOT, REPO, paths, {
      createOctokit: () => ({}) as any,
      pathExists: () => true,
      loadConfig: () => config,
      lookupPr: async () => ({ number: 4, merged: true }) as any,
      emitEvent: ((_f: string, type: string, _i: number, msg: string) => events.push([type, msg])) as any,
    });
    expect(await guard.claimsForIssue(workKeyFromIssue(1))).toEqual([]);
    expect(cleanupWorktree).toHaveBeenCalledTimes(1);
    expect(cleanupWorktree.mock.calls[0]?.slice(0, 2)).toEqual([REPO_ROOT, expectedWorktree()]);
    expect(events).toContainEqual(['landed', 'PR merged']);
  });
});

describe('cleanupMergedLane (#3966)', () => {
  it('cleanupMergedLane releases the lane file claim and removes the lane worktree', async () => {
    const log = vi.fn();
    await cleanupMergedLane(1, REPO_ROOT, REPO, paths, { factoryConfig: config, log });
    expect(await guard.claimsForIssue(workKeyFromIssue(1))).toEqual([]);
    expect(cleanupWorktree).toHaveBeenCalledTimes(1);
    expect(cleanupWorktree.mock.calls[0]?.[1]).toBe(expectedWorktree());
  });

  it('resolves with a warn when cleanupWorktree throws', async () => {
    cleanupWorktree.mockRejectedValueOnce(new Error('disk on fire'));
    const log = vi.fn();
    await expect(cleanupMergedLane(1, REPO_ROOT, REPO, paths, { factoryConfig: config, log })).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('merged-lane cleanup failed for #1'));
  });

  it('leaves the claim alone for an issueless brief PR', async () => {
    await cleanupMergedLane(1, REPO_ROOT, REPO, paths, { factoryConfig: config, issueless: true, log: vi.fn() });
    expect(await guard.claimsForIssue(workKeyFromIssue(1))).toHaveLength(1);
    expect(cleanupWorktree).toHaveBeenCalledTimes(1);
  });
});
