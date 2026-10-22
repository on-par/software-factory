import { execFile as execFileCb } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { PipelineTestKit } from '../test-support/index.js';
import { reapLaneWorktree, setupWorktree } from './index.js';

const execFile = promisify(execFileCb);

describe('lane worktree removal guards (#3443)', () => {
  const kit = new PipelineTestKit();
  afterEach(async () => {
    await kit.cleanup();
  });

  async function lane(issue: number) {
    const { repoRoot } = await kit.makeThrowawayRepo();
    const worktree = kit.trackWorktree(repoRoot, issue);
    const branch = `ship-it/${issue}-x`;
    const keepsFile = join(repoRoot, '..', `keeps-${issue}.json`);
    return { repoRoot, worktree, branch, keepsFile };
  }

  function writeKeep(keepsFile: string, issue: number, path: string): void {
    mkdirSync(join(keepsFile, '..'), { recursive: true });
    writeFileSync(
      keepsFile,
      JSON.stringify([{ issue, path, reason: 'budget_exceeded', since: '2026-10-19T00:00:00.000Z' }]),
    );
  }

  async function branchExists(repoRoot: string, branch: string): Promise<boolean> {
    const { stdout } = await execFile('git', ['branch', '--list', branch], { cwd: repoRoot });
    return stdout.trim() !== '';
  }

  it('setupWorktree refuses to replace a worktree whose issue has a keep record and names the reason', async () => {
    const { repoRoot, worktree, branch, keepsFile } = await lane(3443);
    await setupWorktree(repoRoot, branch, worktree, undefined, undefined, undefined, { keepsFile });
    writeFileSync(join(worktree, 'WORK.txt'), 'parked work\n');
    writeKeep(keepsFile, 3443, worktree);

    await expect(
      setupWorktree(repoRoot, branch, worktree, undefined, undefined, undefined, { keepsFile }),
    ).rejects.toThrow(/budget_exceeded/);
    expect(existsSync(join(worktree, 'WORK.txt'))).toBe(true);
    expect(await branchExists(repoRoot, branch)).toBe(true);
  });

  it('setupWorktree refuses to force-remove a worktree with modified tracked files', async () => {
    const { repoRoot, worktree, branch, keepsFile } = await lane(3444);
    await setupWorktree(repoRoot, branch, worktree, undefined, undefined, undefined, { keepsFile });
    writeFileSync(join(worktree, 'README.md'), 'edited\n');

    await expect(
      setupWorktree(repoRoot, branch, worktree, undefined, undefined, undefined, { keepsFile }),
    ).rejects.toThrow(/uncommitted changes/);
    expect(readFileSync(join(worktree, 'README.md'), 'utf-8')).toBe('edited\n');
    expect(await branchExists(repoRoot, branch)).toBe(true);
  });

  it('setupWorktree replaces a clean worktree with no keep record', async () => {
    const { repoRoot, worktree, branch, keepsFile } = await lane(3445);
    await setupWorktree(repoRoot, branch, worktree, undefined, undefined, undefined, { keepsFile });
    writeFileSync(join(worktree, 'EXTRA.txt'), 'x\n');
    await execFile('git', ['add', 'EXTRA.txt'], { cwd: worktree });
    await execFile('git', ['commit', '-m', 'test: extra'], { cwd: worktree });

    await setupWorktree(repoRoot, branch, worktree, undefined, undefined, undefined, { keepsFile });
    expect(existsSync(join(worktree, 'EXTRA.txt'))).toBe(false);
    expect(existsSync(join(worktree, 'README.md'))).toBe(true);
  });

  it('reapLaneWorktree called from core keeps a worktree with a keep record', async () => {
    const { repoRoot, worktree, branch, keepsFile } = await lane(3446);
    await setupWorktree(repoRoot, branch, worktree, undefined, undefined, undefined, { keepsFile });
    writeKeep(keepsFile, 3446, worktree);
    const log = vi.fn();

    const result = await reapLaneWorktree(repoRoot, worktree, { issue: 3446, branchPrefix: 'ship-it', keepsFile, log });

    expect(result).toMatchObject({ outcome: 'kept-record', branchDeleted: false });
    expect(existsSync(worktree)).toBe(true);
    expect(await branchExists(repoRoot, branch)).toBe(true);
    expect(log).toHaveBeenCalledWith('worktree-gc', expect.stringContaining('kept (budget_exceeded)'));
  });
});
