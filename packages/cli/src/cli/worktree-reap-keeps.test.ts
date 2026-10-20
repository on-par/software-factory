// packages/cli/src/cli/worktree-reap-keeps.test.ts — the park-time reap honors a budget-park keep record (#3316)
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { getFactoryPaths } from '@on-par/factory-core';
import { findWorktreeKeep, type reapLaneWorktree } from '@on-par/factory-core/internal';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { reapParkedLane, type ReapRuntime } from './worktree-reap.js';

describe('reapParkedLane with a keep record', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function setup() {
    dir = mkdtempSync(join(tmpdir(), 'reap-keeps-'));
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

  it('a budget park writes a keep record and the park-time reap leaves the worktree and branch in place', async () => {
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
    expect(reapSpy).not.toHaveBeenCalled();
    expect(existsSync(worktreePath)).toBe(true);
    expect(readFileSync(paths.events, 'utf8')).toContain('kept (budget_exceeded)');
  });

  it('reaps normally when the issue has no keep record', async () => {
    const { repoRoot, paths, rt, reapSpy } = setup();
    await reapParkedLane(rt, reapSpy, [3264, repoRoot, 'o/r', paths, undefined]);
    expect(reapSpy).toHaveBeenCalledTimes(1);
  });
});
