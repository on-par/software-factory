import { describe, expect, it, vi } from 'vitest';
import { computeDiffStat, computeNumstat } from './ship-diff-stat.js';
import type { CommandRunner } from './ship-git.js';

describe('computeDiffStat', () => {
  it('reads the worktree diff against the PR base and caps it at the final 20 lines', async () => {
    const lines = Array.from({ length: 25 }, (_, i) => `file-${i}`);
    const run = vi.fn<CommandRunner>().mockResolvedValue({ stdout: lines.join('\n') });
    expect(await computeDiffStat(run, '/worktree', 'main')).toBe(lines.slice(-20).join('\n'));
    expect(run).toHaveBeenCalledWith('git diff --stat origin/main...HEAD', { cwd: '/worktree' });
  });

  it('diffs a stacked PR against its base branch, not main', async () => {
    const run = vi.fn<CommandRunner>().mockResolvedValue({ stdout: '' });
    await computeDiffStat(run, '/worktree', 'factory/9-a');
    expect(run).toHaveBeenCalledWith('git diff --stat origin/factory/9-a...HEAD', { cwd: '/worktree' });
  });

  it('quotes a base branch with shell metacharacters', async () => {
    const run = vi.fn<CommandRunner>().mockResolvedValue({ stdout: '' });
    await computeDiffStat(run, '/worktree', 'feat;rm');
    expect(run).toHaveBeenCalledWith("git diff --stat 'origin/feat;rm...HEAD'", { cwd: '/worktree' });
  });

  it('omits the stat when git fails', async () => {
    const run = vi.fn<CommandRunner>().mockRejectedValue(new Error('no base ref'));
    expect(await computeDiffStat(run, '/worktree', 'main')).toBe('');
  });
});

describe('computeNumstat', () => {
  it('runs the numstat command against the PR base and returns stdout', async () => {
    const run = vi.fn<CommandRunner>().mockResolvedValue({ stdout: '1\t2\ta.ts\n' });
    expect(await computeNumstat(run, '/worktree', 'main')).toBe('1\t2\ta.ts\n');
    expect(run).toHaveBeenCalledWith('git diff --numstat origin/main...HEAD', { cwd: '/worktree' });
  });

  it('counts a stacked PR against its base branch', async () => {
    const run = vi.fn<CommandRunner>().mockResolvedValue({ stdout: '' });
    await computeNumstat(run, '/worktree', 'factory/9-a');
    expect(run).toHaveBeenCalledWith('git diff --numstat origin/factory/9-a...HEAD', { cwd: '/worktree' });
  });

  it('rethrows a git failure', async () => {
    const run = vi.fn<CommandRunner>().mockRejectedValue(new Error('no base ref'));
    await expect(computeNumstat(run, '/worktree', 'main')).rejects.toThrow('no base ref');
  });
});
