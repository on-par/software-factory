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

describe('kept lane branch name collision (#3651)', () => {
  const kit = new PipelineTestKit();
  afterEach(async () => {
    await kit.cleanup();
  });
  const branch = 'factory/3325-land-when-merging-origin-main-in';
  const now = () => new Date('2026-10-24T12:00:00Z');
  const bak = `${branch}.bak-20261024`;

  async function git(cwd: string, ...args: string[]): Promise<string> {
    const { stdout } = await execFile('git', args, { cwd });
    return stdout.trim();
  }

  /** A kept lane branch with one extra commit, optionally pushed, and held by a second worktree so -D fails. */
  async function stuckBranch(push: boolean) {
    const { repoRoot, origin } = await kit.makeThrowawayRepo();
    await git(repoRoot, 'branch', branch, 'origin/main');
    const holder = `${repoRoot}-holder-3325`;
    await git(repoRoot, 'worktree', 'add', holder, branch);
    kit.trackWorktree(repoRoot, 3325);
    writeFileSync(join(holder, 'KEPT.txt'), 'kept\n');
    await git(holder, 'add', 'KEPT.txt');
    await git(holder, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'kept work');
    const oldTip = await git(repoRoot, 'rev-parse', branch);
    if (push) await git(repoRoot, 'push', 'origin', branch);
    return { repoRoot, origin, oldTip, holder, worktree: `${repoRoot}-wt-3325` };
  }

  it('kept factory/<n>-* branch with no open PR does not fail setupWorktree with already exists', async () => {
    const { repoRoot, oldTip, worktree } = await stuckBranch(false);
    const res = await setupWorktree(repoRoot, branch, worktree, undefined, undefined, undefined, {
      findOpenPr: async () => ({ status: 'absent' }),
      now,
    });
    expect(await git(worktree, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(branch);
    expect(res.head).toBe(await git(repoRoot, 'rev-parse', 'origin/main'));
    expect(await git(repoRoot, 'rev-parse', bak)).toBe(oldTip);
  });

  it('renames a kept branch with a closed PR aside locally and on origin, then creates a fresh lane worktree from the base', async () => {
    const { repoRoot, origin, worktree } = await stuckBranch(true);
    const log = vi.fn();
    const res = await setupWorktree(repoRoot, branch, worktree, undefined, undefined, log, {
      findOpenPr: async () => ({ status: 'absent' }),
      now,
    });
    expect(await git(origin, 'ls-remote', '--heads', origin, bak)).not.toBe('');
    expect(await git(origin, 'ls-remote', '--heads', origin, branch)).toBe('');
    expect(res.base).toBe('origin/main');
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('.bak-20261024'));
  });

  it('open PR owning a stuck lane branch continues on origin/<branch> and leaves origin untouched', async () => {
    const { repoRoot, origin, worktree } = await stuckBranch(true);
    const originSha = await git(origin, 'rev-parse', branch);
    const res = await setupWorktree(repoRoot, branch, worktree, undefined, undefined, undefined, {
      findOpenPr: async () => ({ status: 'found', prNumber: 42 }),
      now,
    });
    expect(res.base).toBe(`origin/${branch}`);
    expect(res.head).toBe(originSha);
    expect(await git(origin, 'ls-remote', '--heads', origin, branch)).not.toBe('');
    expect(await git(origin, 'ls-remote', '--heads', origin, bak)).toBe('');
  });

  it('a second rename on the same day uses -2', async () => {
    const { repoRoot, worktree } = await stuckBranch(false);
    await git(repoRoot, 'branch', bak, 'origin/main');
    await setupWorktree(repoRoot, branch, worktree, undefined, undefined, undefined, { now });
    expect(await git(repoRoot, 'rev-parse', '--verify', `${bak}-2`)).not.toBe('');
  });
});
