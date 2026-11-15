import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { sweepBetweenLaneIssues } from './index.js';

describe('sweepBetweenLaneIssues protectedIssues (#2964)', () => {
  let tmp: string;
  const writtenEvents = (): any[] =>
    readFileSync(lanePaths.events, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l));
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
    const seen: any[] = [];
    const sweep = async (opts: any) => {
      seen.push(opts);
      return idleReport;
    };
    const protectedSet = new Set([9, 12]);
    const deps = {
      loadConfig: () => ({ worktree: { autoGcOnRun: true, gcTtlDays: 7 } }) as any,
      octokit: () => undefined as any,
    };
    await sweepBetweenLaneIssues(7, 'app', tmp, 'o/r', lanePaths, {
      ...deps,
      sweep,
      protectedIssues: () => protectedSet,
    });
    expect(seen[0].protectedIssues).toBe(protectedSet);

    seen.length = 0;
    await sweepBetweenLaneIssues(7, 'app', tmp, 'o/r', lanePaths, { ...deps, sweep });
    expect([...seen[0].protectedIssues]).toEqual([]);
  });

  it('runs the retention budget pass with the in-flight set and the configured budget (#3970)', async () => {
    const sweep = async () => idleReport;
    const evicted = { path: '/x', branch: 'b', issue: 4, ageDays: 1, kind: 'finished', protectedBy: null, why: null };
    const reclaimed: any[] = [];
    const reclaim = async (opts: any) => {
      reclaimed.push(opts);
      return {
        retained: 3,
        target: 2,
        evict: [evicted],
        protected: [],
        evicted: [evicted],
        failed: [],
      };
    };
    const inFlight = new Set([9]);
    const result = await sweepBetweenLaneIssues(7, 'app', tmp, 'o/r', lanePaths, {
      loadConfig: () => ({ worktree: { autoGcOnRun: true, gcTtlDays: 7, retainMax: 2 } }) as any,
      octokit: () => undefined as any,
      sweep: sweep as any,
      reclaim: reclaim as any,
      protectedIssues: () => inFlight,
    });
    expect(result).toBe('swept');
    expect(reclaimed[0].protectedIssues).toBe(inFlight);
    expect(reclaimed[0].policy).toEqual({ maxRetained: 2 });
    expect(reclaimed[0].pressure).toBeUndefined();
    expect(writtenEvents()).toContainEqual(
      expect.objectContaining({
        type: 'worktree-gc',
        msg: 'retention: evicted 1 of 3 retained worktree(s) (budget 2)',
        lane: 'app',
        issue: '7',
      }),
    );
  });

  it('keeps the sweep result when the retention pass throws (#3970)', async () => {
    const sweep = async () => idleReport;
    const result = await sweepBetweenLaneIssues(7, 'app', tmp, 'o/r', lanePaths, {
      loadConfig: () => ({ worktree: { autoGcOnRun: true, gcTtlDays: 7 } }) as any,
      octokit: () => undefined as any,
      sweep: sweep as any,
      reclaim: (async () => {
        throw new Error('boom');
      }) as any,
    });
    expect(result).toBe('swept');
    expect(writtenEvents()).toContainEqual(
      expect.objectContaining({ type: 'warn', msg: expect.stringContaining('boom'), lane: 'app' }),
    );
  });
});
