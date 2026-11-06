import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { sweepBetweenLaneIssues } from './index.js';

describe('sweepBetweenLaneIssues protectedIssues (#2964)', () => {
  let tmp: string;
  let lanePaths: any;
  const idleReport = {
    removed: [],
    kept: 0,
    dryRun: false,
    issueNotFound: [],
    issueUnverifiable: [],
    noActiveClaim: [],
    held: [],
  };

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'sweep-protected-'));
    lanePaths = {
      events: join(tmp, 'events.ndjson'),
      config: join(tmp, 'config.yaml'),
      mergeLock: join(tmp, 'merge.lock'),
      gitLock: join(tmp, 'git.lock'),
    };
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('forwards protectedIssues to the sweep (#2964)', async () => {
    const sweep = vi.fn(async () => idleReport);
    const protectedSet = new Set([9, 12]);
    const deps = {
      loadConfig: () => ({ worktree: { autoGcOnRun: true, gcTtlDays: 7 } }) as any,
      emitEvent: vi.fn() as any,
      octokit: () => undefined as any,
    };
    await sweepBetweenLaneIssues(7, 'app', tmp, 'o/r', lanePaths, {
      ...deps,
      sweep: sweep as any,
      protectedIssues: () => protectedSet,
    });
    expect((sweep.mock.calls[0] as any[])[0].protectedIssues).toBe(protectedSet);

    sweep.mockClear();
    await sweepBetweenLaneIssues(7, 'app', tmp, 'o/r', lanePaths, { ...deps, sweep: sweep as any });
    expect([...(sweep.mock.calls[0] as any[])[0].protectedIssues]).toEqual([]);
  });

  it('runs the retention budget pass with the in-flight set and the configured budget (#3970)', async () => {
    const sweep = vi.fn(async () => idleReport);
    const evicted = { path: '/x', branch: 'b', issue: 4, ageDays: 1, kind: 'finished', protectedBy: null, why: null };
    const reclaim = vi.fn(async () => ({
      retained: 3,
      target: 2,
      evict: [evicted],
      protected: [],
      evicted: [evicted],
      failed: [],
    }));
    const emitEvent = vi.fn();
    const inFlight = new Set([9]);
    const result = await sweepBetweenLaneIssues(7, 'app', tmp, 'o/r', lanePaths, {
      loadConfig: () => ({ worktree: { autoGcOnRun: true, gcTtlDays: 7, retainMax: 2 } }) as any,
      emitEvent: emitEvent as any,
      octokit: () => undefined as any,
      sweep: sweep as any,
      reclaim: reclaim as any,
      protectedIssues: () => inFlight,
    });
    expect(result).toBe('swept');
    const [opts] = reclaim.mock.calls[0] as any[];
    expect(opts.protectedIssues).toBe(inFlight);
    expect(opts.policy).toEqual({ maxRetained: 2 });
    expect(opts.pressure).toBeUndefined();
    expect(emitEvent).toHaveBeenCalledWith(
      expect.any(String),
      'worktree-gc',
      7,
      'retention: evicted 1 of 3 retained worktree(s) (budget 2)',
      { lane: 'app' },
    );
  });

  it('keeps the sweep result when the retention pass throws (#3970)', async () => {
    const sweep = vi.fn(async () => idleReport);
    const emitEvent = vi.fn();
    const result = await sweepBetweenLaneIssues(7, 'app', tmp, 'o/r', lanePaths, {
      loadConfig: () => ({ worktree: { autoGcOnRun: true, gcTtlDays: 7 } }) as any,
      emitEvent: emitEvent as any,
      octokit: () => undefined as any,
      sweep: sweep as any,
      reclaim: (async () => {
        throw new Error('boom');
      }) as any,
    });
    expect(result).toBe('swept');
    expect(emitEvent).toHaveBeenCalledWith(expect.any(String), 'warn', 7, expect.stringContaining('boom'), {
      lane: 'app',
    });
  });
});
