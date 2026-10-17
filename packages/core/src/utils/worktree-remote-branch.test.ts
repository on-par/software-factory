import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { PipelineTestKit } from '../test-support/index.js';
import { detectRemoteBranch, gitFetch, setupWorktree } from './index.js';

const execFile = promisify(execFileCb);
const kit = new PipelineTestKit();

afterEach(() => kit.cleanup());

describe('pre-existing remote branch (#1868)', () => {
  async function pushBranch(repoRoot: string, branch: string): Promise<string> {
    await execFile('git', ['commit', '--allow-empty', '-m', 'earlier run'], { cwd: repoRoot });
    await execFile('git', ['push', 'origin', `HEAD:refs/heads/${branch}`], { cwd: repoRoot });
    await execFile('git', ['reset', '--hard', 'HEAD~1'], { cwd: repoRoot });
    await gitFetch(repoRoot);
    const { stdout } = await execFile('git', ['rev-parse', `origin/${branch}`], { cwd: repoRoot });
    return stdout.trim();
  }

  it('records the SHA and open PR and bases the worktree on the PR branch (#3099)', async () => {
    const { repoRoot } = await kit.makeThrowawayRepo();
    const branch = 'ship-it/207-preexisting';
    const sha = await pushBranch(repoRoot, branch);
    const worktree = kit.trackWorktree(repoRoot, 207);
    const log = vi.fn();

    const result = await setupWorktree(repoRoot, branch, worktree, undefined, undefined, log, {
      findOpenPr: async () => ({ status: 'found', prNumber: 42 }),
    });

    expect(result.remoteBranch).toEqual({ sha, prNumber: 42 });
    expect(result.base).toBe(`origin/${branch}`);
    const events = log.mock.calls.filter(([type]) => type === 'remote-branch-preexisting');
    expect(events).toHaveLength(1);
    expect(events[0][1]).toContain(sha);
    expect(events[0][1]).toContain('#42');
    expect(events[0][1]).toContain(`continuing on origin/${branch}`);
    const { stdout } = await execFile('git', ['rev-parse', 'HEAD'], { cwd: worktree });
    expect(stdout.trim()).toBe(sha);
  });

  it('keeps an explicit startPoint authoritative when an open PR is found', async () => {
    const { repoRoot } = await kit.makeThrowawayRepo();
    const branch = 'ship-it/211-preexisting';
    await pushBranch(repoRoot, branch);
    const worktree = kit.trackWorktree(repoRoot, 211);
    const log = vi.fn();

    const result = await setupWorktree(repoRoot, branch, worktree, 'origin/main', undefined, log, {
      findOpenPr: async () => ({ status: 'found', prNumber: 42 }),
    });

    expect(result.base).toBe('origin/main');
    const event = log.mock.calls.find(([type]) => type === 'remote-branch-preexisting');
    expect(event?.[1]).toContain('#42');
    expect(event?.[1]).not.toContain('continuing');
    const { stdout } = await execFile('git', ['rev-parse', 'HEAD'], { cwd: worktree });
    const { stdout: main } = await execFile('git', ['rev-parse', 'origin/main'], { cwd: repoRoot });
    expect(stdout.trim()).toBe(main.trim());
  });

  it.each([
    ['no open PR', async () => ({ status: 'absent' as const }), 'no open PR'],
    ['error status', async () => ({ status: 'error' as const, detail: 'boom' }), 'lookup failed: boom'],
    [
      'throwing lookup',
      async (): Promise<never> => {
        throw new Error('kaboom');
      },
      'lookup failed: kaboom',
    ],
  ])('still records the SHA when the PR lookup yields %s', async (_name, findOpenPr, text) => {
    const { repoRoot } = await kit.makeThrowawayRepo();
    const branch = 'ship-it/208-preexisting';
    const sha = await pushBranch(repoRoot, branch);
    const worktree = kit.trackWorktree(repoRoot, 208);
    const log = vi.fn();

    const result = await setupWorktree(repoRoot, branch, worktree, undefined, undefined, log, { findOpenPr });

    expect(result.remoteBranch).toEqual({ sha });
    expect(result.base).toBe('origin/main');
    const { stdout: head } = await execFile('git', ['rev-parse', 'HEAD'], { cwd: worktree });
    const { stdout: main } = await execFile('git', ['rev-parse', 'origin/main'], { cwd: repoRoot });
    expect(head.trim()).toBe(main.trim());
    expect(log).toHaveBeenCalledWith('remote-branch-preexisting', expect.stringContaining(text));
  });

  it('reports the PR as not checked when no lookup is injected', async () => {
    const { repoRoot } = await kit.makeThrowawayRepo();
    const branch = 'ship-it/209-preexisting';
    await pushBranch(repoRoot, branch);
    const worktree = kit.trackWorktree(repoRoot, 209);
    const log = vi.fn();

    await setupWorktree(repoRoot, branch, worktree, undefined, undefined, log);

    expect(log).toHaveBeenCalledWith('remote-branch-preexisting', expect.stringContaining('not checked'));
  });

  it('records nothing and never looks up a PR when the remote branch does not exist', async () => {
    const { repoRoot } = await kit.makeThrowawayRepo();
    const worktree = kit.trackWorktree(repoRoot, 210);
    const log = vi.fn();
    const findOpenPr = vi.fn();

    const result = await setupWorktree(repoRoot, 'ship-it/210-fresh', worktree, undefined, undefined, log, {
      findOpenPr,
    });

    expect(result.remoteBranch).toBeNull();
    expect(log.mock.calls.some(([type]) => type === 'remote-branch-preexisting')).toBe(false);
    expect(findOpenPr).not.toHaveBeenCalled();
  });

  it('detectRemoteBranch returns the SHA for an existing branch and null for a missing one', async () => {
    const { repoRoot } = await kit.makeThrowawayRepo();
    const { stdout } = await execFile('git', ['rev-parse', 'origin/main'], { cwd: repoRoot });

    await expect(detectRemoteBranch(repoRoot, 'main')).resolves.toBe(stdout.trim());
    await expect(detectRemoteBranch(repoRoot, 'nope/missing')).resolves.toBeNull();
  });
});
