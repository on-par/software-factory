import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { PipelineTestKit } from '../test-support/index.js';
import { gitFetch, setupWorktree } from './index.js';

const execFile = promisify(execFileCb);

describe('setupWorktree adopted remote branch (#2253)', () => {
  const kit = new PipelineTestKit();

  afterEach(async () => {
    await kit.cleanup();
  });

  async function pushBranch(repoRoot: string, branch: string): Promise<string> {
    await execFile('git', ['commit', '--allow-empty', '-m', 'earlier run'], { cwd: repoRoot });
    await execFile('git', ['push', 'origin', `HEAD:refs/heads/${branch}`], { cwd: repoRoot });
    await execFile('git', ['reset', '--hard', 'HEAD~1'], { cwd: repoRoot });
    await gitFetch(repoRoot);
    const { stdout } = await execFile('git', ['rev-parse', `origin/${branch}`], { cwd: repoRoot });
    return stdout.trim();
  }

  it('marks the remote branch adopted and starts from it when startPoint is origin/<branch>', async () => {
    const { repoRoot } = await kit.makeThrowawayRepo();
    const branch = 'ship-it/210-adopt';
    const sha = await pushBranch(repoRoot, branch);
    const worktree = kit.trackWorktree(repoRoot, 210);
    const log = vi.fn();

    const result = await setupWorktree(repoRoot, branch, worktree, `origin/${branch}`, undefined, log);

    expect(result.remoteBranch).toEqual({ sha, adopted: true });
    expect(result.head).toBe(sha);
    expect(log).toHaveBeenCalledWith('remote-branch-preexisting', expect.stringContaining('adopted as worktree base'));
  });

  it('does not mark the remote branch adopted from the default base', async () => {
    const { repoRoot } = await kit.makeThrowawayRepo();
    const branch = 'ship-it/211-not-adopted';
    const sha = await pushBranch(repoRoot, branch);
    const worktree = kit.trackWorktree(repoRoot, 211);

    const result = await setupWorktree(repoRoot, branch, worktree);

    expect(result.remoteBranch).toEqual({ sha });
  });
});
