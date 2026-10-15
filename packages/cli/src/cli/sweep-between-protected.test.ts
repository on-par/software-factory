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
});
