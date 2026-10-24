import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { PipelineTestKit } from '../test-support/index.js';
import { bakBranchName, moveLaneBranchAside } from './lane-branch-aside.js';

const execFile = promisify(execFileCb);

describe('bakBranchName', () => {
  const day = new Date('2026-10-24T12:00:00Z');
  it('uses the UTC date when free', () => {
    expect(bakBranchName('factory/1-x', day, () => false)).toBe('factory/1-x.bak-20261024');
  });
  it('appends -2 then -3 when taken', () => {
    const taken = new Set(['factory/1-x.bak-20261024']);
    expect(bakBranchName('factory/1-x', day, (n) => taken.has(n))).toBe('factory/1-x.bak-20261024-2');
    taken.add('factory/1-x.bak-20261024-2');
    expect(bakBranchName('factory/1-x', day, (n) => taken.has(n))).toBe('factory/1-x.bak-20261024-3');
  });
  it('uses the UTC date at a day boundary', () => {
    expect(bakBranchName('b', new Date('2026-10-24T23:59:59Z'), () => false)).toBe('b.bak-20261024');
    expect(bakBranchName('b', new Date('2026-10-25T00:00:00Z'), () => false)).toBe('b.bak-20261025');
  });
});

describe('moveLaneBranchAside', () => {
  const kit = new PipelineTestKit();
  afterEach(async () => {
    await kit.cleanup();
  });
  const branch = 'factory/3651-x';
  const now = () => new Date('2026-10-24T12:00:00Z');

  async function repoWithPushedBranch() {
    const { repoRoot, origin } = await kit.makeThrowawayRepo();
    await execFile('git', ['branch', branch, 'main'], { cwd: repoRoot });
    await execFile('git', ['push', 'origin', branch], { cwd: repoRoot });
    const { stdout } = await execFile('git', ['rev-parse', branch], { cwd: repoRoot });
    return { repoRoot, origin, sha: stdout.trim() };
  }

  it.each([['error' as const], [null]])('leaves origin untouched when prStatus is %s', async (prStatus) => {
    const { repoRoot, origin, sha } = await repoWithPushedBranch();
    const log = vi.fn();
    const res = await moveLaneBranchAside(repoRoot, branch, { remoteSha: sha, prStatus, now, log });
    expect(res).toEqual({ bak: `${branch}.bak-20261024`, remoteMoved: false });
    const { stdout } = await execFile('git', ['ls-remote', '--heads', origin, branch], { cwd: repoRoot });
    expect(stdout.trim()).not.toBe('');
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('local only'));
  });

  it('warns and does not throw when the origin move fails', async () => {
    const { repoRoot, sha } = await repoWithPushedBranch();
    const log = vi.fn();
    const res = await moveLaneBranchAside(repoRoot, branch, {
      remoteSha: 'f'.repeat(40),
      prStatus: 'absent',
      now,
      log,
    });
    expect(res.remoteMoved).toBe(false);
    expect(sha).not.toBe('');
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('could not move origin/'));
  });

  it('rejects naming the branch when the rename fails', async () => {
    const { repoRoot } = await kit.makeThrowawayRepo();
    await expect(
      moveLaneBranchAside(repoRoot, branch, { remoteSha: null, prStatus: null, now, log: vi.fn() }),
    ).rejects.toThrow(new RegExp(branch));
  });
});
