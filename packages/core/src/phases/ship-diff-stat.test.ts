import { describe, expect, it } from 'vitest';
import { recorder } from '../test-support/recording-fakes.test.js';
import { computeDiffStat, computeNumstat } from './ship-diff-stat.js';
import type { CommandRunner } from './ship-git.js';

const runner = (stdout = '') => recorder(async () => ({ stdout }));
const failing: CommandRunner = async () => {
  throw new Error('no base ref');
};

describe('computeDiffStat', () => {
  it('reads the worktree diff against the PR base and caps it at the final 20 lines', async () => {
    const lines = Array.from({ length: 25 }, (_, i) => `file-${i}`);
    const run = runner(lines.join('\n'));
    expect(await computeDiffStat(run, '/worktree', 'main')).toBe(lines.slice(-20).join('\n'));
    expect(run.calls).toEqual([['git diff --stat origin/main...HEAD', { cwd: '/worktree' }]]);
  });

  it.each([
    ['factory/9-a', 'git diff --stat origin/factory/9-a...HEAD'],
    ['feat;rm', "git diff --stat 'origin/feat;rm...HEAD'"],
  ])('diffs against base %s, quoting shell metacharacters', async (base, command) => {
    const run = runner();
    await computeDiffStat(run, '/worktree', base);
    expect(run.calls).toEqual([[command, { cwd: '/worktree' }]]);
  });

  it('omits the stat when git fails', async () => {
    expect(await computeDiffStat(failing, '/worktree', 'main')).toBe('');
  });
});

describe('computeNumstat', () => {
  it.each([
    ['main', '1\t2\ta.ts\n'],
    ['factory/9-a', ''],
  ])('runs the numstat command against base %s and returns stdout', async (base, stdout) => {
    const run = runner(stdout);
    expect(await computeNumstat(run, '/worktree', base)).toBe(stdout);
    expect(run.calls).toEqual([[`git diff --numstat origin/${base}...HEAD`, { cwd: '/worktree' }]]);
  });

  it('rethrows a git failure', async () => {
    await expect(computeNumstat(failing, '/worktree', 'main')).rejects.toThrow('no base ref');
  });
});
