// packages/cli/src/cli/worktree-reap-keeps.test.ts — the park-time reap honors a budget-park keep record (#3316)
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { getFactoryPaths } from '@on-par/factory-core';
import { findWorktreeKeep, type reapLaneWorktree } from '@on-par/factory-core/internal';
import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { reapParkedLane, type ReapRuntime } from './worktree-reap.js';

describe('reapParkedLane with a keep record', () => {
  const tmp = createTempDirs();
  afterEach(() => tmp.cleanup());

  function setup() {
    const dir = tmp.makeSync('reap-keeps-');
    const repoRoot = join(dir, 'repo');
    const worktreePath = join(dir, 'repo-factory-3264');
    mkdirSync(repoRoot, { recursive: true });
    mkdirSync(worktreePath, { recursive: true });
    const paths = getFactoryPaths(repoRoot, join(dir, 'state'));
    const rt: ReapRuntime = {
      configLoaders: { loadFactoryConfigForRepo: () => ({}) as never, loadRepoConfig: () => ({}) as never },
      worktreePathFor: () => worktreePath,
    };
    const absent: Awaited<ReturnType<typeof reapLaneWorktree>> = {
      outcome: 'absent',
      branch: null,
      branchDeleted: false,
    };
    const reapSpy = vi.fn(async (..._args: Parameters<typeof reapLaneWorktree>) => absent);
    return { repoRoot, worktreePath, paths, rt, reapSpy };
  }

  it('a budget park writes a keep record and the park-time reap hands it to reapLaneWorktree, which keeps the worktree', async () => {
    const { repoRoot, worktreePath, paths, rt, reapSpy } = setup();
    // The record enforceIssueBudget writes on a budget park (budget.test.ts covers the writer).
    mkdirSync(dirname(paths.worktreeKeeps), { recursive: true });
    writeFileSync(
      paths.worktreeKeeps,
      JSON.stringify([
        { issue: 3264, path: worktreePath, reason: 'budget_exceeded', since: '2026-10-19T00:00:00.000Z' },
      ]),
    );
    await reapParkedLane(rt, reapSpy, [3264, repoRoot, 'o/r', paths, undefined]);
    expect(findWorktreeKeep(paths.worktreeKeeps, 3264)?.reason).toBe('budget_exceeded');
    expect(reapSpy).toHaveBeenCalledTimes(1);
    expect(reapSpy.mock.calls[0][2]).toMatchObject({ issue: 3264, keepsFile: paths.worktreeKeeps });
    expect(existsSync(worktreePath)).toBe(true);
  });

  it('reaps normally when the issue has no keep record', async () => {
    const { repoRoot, paths, rt, reapSpy } = setup();
    await reapParkedLane(rt, reapSpy, [3264, repoRoot, 'o/r', paths, undefined]);
    expect(reapSpy).toHaveBeenCalledTimes(1);
  });
});
