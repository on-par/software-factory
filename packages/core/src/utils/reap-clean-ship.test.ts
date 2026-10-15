// packages/core/src/utils/reap-clean-ship.test.ts — reapCleanShipWorktree against real throwaway git repos (#3008)
import { execFile as execFileCb } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { PipelineTestKit } from '../test-support/index.js';
import { reapCleanShipWorktree, setupWorktree } from './index.js';

const execFile = promisify(execFileCb);

describe('reapCleanShipWorktree', () => {
  const kit = new PipelineTestKit();

  afterEach(async () => {
    await kit.cleanup();
  });

  async function branchList(repoRoot: string, branch: string): Promise<string> {
    const { stdout } = await execFile('git', ['branch', '--list', branch], { cwd: repoRoot });
    return stdout.trim();
  }

  it('removes a clean zero-commit lane worktree and deletes its branch', async () => {
    const { repoRoot } = await kit.makeThrowawayRepo();
    const worktree = kit.trackWorktree(repoRoot, 401);
    const branch = 'ship-it/401-x';
    await setupWorktree(repoRoot, branch, worktree);

    const result = await reapCleanShipWorktree(repoRoot, worktree, { issue: 401 });

    expect(result).toEqual({ outcome: 'removed', branch, branchDeleted: true });
    expect(existsSync(worktree)).toBe(false);
    expect(await branchList(repoRoot, branch)).toBe('');
  });

  it('keeps a worktree with commits beyond the base', async () => {
    const { repoRoot } = await kit.makeThrowawayRepo();
    const worktree = kit.trackWorktree(repoRoot, 402);
    const branch = 'ship-it/402-x';
    await setupWorktree(repoRoot, branch, worktree);
    writeFileSync(join(worktree, 'WORK.txt'), 'work\n');
    await execFile('git', ['add', 'WORK.txt'], { cwd: worktree });
    await execFile('git', ['commit', '-m', 'test: lane work'], { cwd: worktree });

    const result = await reapCleanShipWorktree(repoRoot, worktree, { issue: 402 });

    expect(result).toEqual({ outcome: 'kept-committed', branch, branchDeleted: false });
    expect(existsSync(worktree)).toBe(true);
    expect(await branchList(repoRoot, branch)).toContain(branch);
  });

  it('keeps a worktree with modified tracked files', async () => {
    const { repoRoot } = await kit.makeThrowawayRepo();
    const worktree = kit.trackWorktree(repoRoot, 403);
    const branch = 'ship-it/403-x';
    await setupWorktree(repoRoot, branch, worktree);
    writeFileSync(join(worktree, 'README.md'), 'live uncommitted work\n');

    const result = await reapCleanShipWorktree(repoRoot, worktree, { issue: 403 });

    expect(result).toEqual({ outcome: 'kept-dirty', branch, branchDeleted: false });
    expect(existsSync(worktree)).toBe(true);
  });

  it('keeps a worktree with untracked files', async () => {
    const { repoRoot } = await kit.makeThrowawayRepo();
    const worktree = kit.trackWorktree(repoRoot, 404);
    const branch = 'ship-it/404-x';
    await setupWorktree(repoRoot, branch, worktree);
    writeFileSync(join(worktree, 'NEW.txt'), 'untracked\n');

    const result = await reapCleanShipWorktree(repoRoot, worktree, { issue: 404 });

    expect(result).toEqual({ outcome: 'kept-dirty', branch, branchDeleted: false });
    expect(existsSync(worktree)).toBe(true);
  });

  it('leaves a worktree on a non-lane branch alone', async () => {
    const { repoRoot } = await kit.makeThrowawayRepo();
    const worktree = kit.trackWorktree(repoRoot, 405);
    const branch = 'manual/experiment-x';
    await setupWorktree(repoRoot, branch, worktree);

    const result = await reapCleanShipWorktree(repoRoot, worktree, { issue: 405 });

    expect(result).toEqual({ outcome: 'kept-branch-mismatch', branch, branchDeleted: false });
    expect(existsSync(worktree)).toBe(true);
    expect(await branchList(repoRoot, branch)).toContain(branch);
  });

  it('returns absent for a missing path', async () => {
    const { repoRoot } = await kit.makeThrowawayRepo();

    const result = await reapCleanShipWorktree(repoRoot, join(repoRoot, '..', 'no-such-worktree-998'), {
      issue: 998,
    });

    expect(result).toEqual({ outcome: 'absent', branch: null, branchDeleted: false });
  });
});
