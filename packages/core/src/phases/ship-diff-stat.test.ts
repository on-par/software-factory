import { describe, expect, it } from 'vitest';
import { computeDiffStat, computeNumstat } from './ship-diff-stat.js';
import type { CommandRunner } from './ship-git.js';

function recordingRunner(stdout: string): { run: CommandRunner; calls: Array<[string, unknown]> } {
  const calls: Array<[string, unknown]> = [];
  const run: CommandRunner = async (cmd, options) => {
    calls.push([cmd, options]);
    return { stdout };
  };
  return { run, calls };
}

const failingRunner: CommandRunner = async () => {
  throw new Error('no base ref');
};

describe('computeDiffStat', () => {
  it('reads the worktree diff against the PR base and caps it at the final 20 lines', async () => {
    const lines = Array.from({ length: 25 }, (_, i) => `file-${i}`);
    const { run, calls } = recordingRunner(lines.join('\n'));
    expect(await computeDiffStat(run, '/worktree', 'main')).toBe(lines.slice(-20).join('\n'));
    expect(calls).toEqual([['git diff --stat origin/main...HEAD', { cwd: '/worktree' }]]);
  });

  it('diffs a stacked PR against its base branch, not main', async () => {
    const { run, calls } = recordingRunner('');
    await computeDiffStat(run, '/worktree', 'factory/9-a');
    expect(calls).toEqual([['git diff --stat origin/factory/9-a...HEAD', { cwd: '/worktree' }]]);
  });

  it('quotes a base branch with shell metacharacters', async () => {
    const { run, calls } = recordingRunner('');
    await computeDiffStat(run, '/worktree', 'feat;rm');
    expect(calls).toEqual([["git diff --stat 'origin/feat;rm...HEAD'", { cwd: '/worktree' }]]);
  });

  it('omits the stat when git fails', async () => {
    expect(await computeDiffStat(failingRunner, '/worktree', 'main')).toBe('');
  });
});

describe('computeNumstat', () => {
  it('runs the numstat command against the PR base and returns stdout', async () => {
    const { run, calls } = recordingRunner('1\t2\ta.ts\n');
    expect(await computeNumstat(run, '/worktree', 'main')).toBe('1\t2\ta.ts\n');
    expect(calls).toEqual([['git diff --numstat origin/main...HEAD', { cwd: '/worktree' }]]);
  });

  it('counts a stacked PR against its base branch', async () => {
    const { run, calls } = recordingRunner('');
    await computeNumstat(run, '/worktree', 'factory/9-a');
    expect(calls).toEqual([['git diff --numstat origin/factory/9-a...HEAD', { cwd: '/worktree' }]]);
  });

  it('rethrows a git failure', async () => {
    await expect(computeNumstat(failingRunner, '/worktree', 'main')).rejects.toThrow('no base ref');
  });
});
