import { describe, expect, it, vi } from 'vitest';
import { computeDiffStat, computeNumstat } from './ship-diff-stat.js';
import type { CommandRunner } from './ship-git.js';

describe('computeDiffStat', () => {
  it('reads the worktree diff and caps it at the final 20 lines', async () => {
    const lines = Array.from({ length: 25 }, (_, i) => `file-${i}`);
    const run = vi.fn<CommandRunner>().mockResolvedValue({ stdout: lines.join('\n') });
    expect(await computeDiffStat(run, '/worktree')).toBe(lines.slice(-20).join('\n'));
    expect(run).toHaveBeenCalledWith('git diff --stat origin/main...HEAD', { cwd: '/worktree' });
  });

  it('omits the stat when git fails', async () => {
    const run = vi.fn<CommandRunner>().mockRejectedValue(new Error('no base ref'));
    expect(await computeDiffStat(run, '/worktree')).toBe('');
  });
});

describe('computeNumstat', () => {
  it('runs the numstat command in the worktree and returns stdout', async () => {
    const run = vi.fn<CommandRunner>().mockResolvedValue({ stdout: '1\t2\ta.ts\n' });
    expect(await computeNumstat(run, '/worktree')).toBe('1\t2\ta.ts\n');
    expect(run).toHaveBeenCalledWith('git diff --numstat origin/main...HEAD', { cwd: '/worktree' });
  });

  it('rethrows a git failure', async () => {
    const run = vi.fn<CommandRunner>().mockRejectedValue(new Error('no base ref'));
    await expect(computeNumstat(run, '/worktree')).rejects.toThrow('no base ref');
  });
});
