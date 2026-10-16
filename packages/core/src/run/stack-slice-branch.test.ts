import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createStackSliceBranch } from './stack-slice-branch.js';

describe('createStackSliceBranch', () => {
  let dir: string;
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  const commit = (name: string) => {
    writeFileSync(join(dir, name), name);
    git('add', '.');
    git('commit', '-m', name);
    return git('rev-parse', 'HEAD');
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'stack-branch-'));
    git('init', '-b', 'main');
    git('config', 'user.name', 'T');
    git('config', 'user.email', 't@example.com');
    git('config', 'commit.gpgsign', 'false');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('creates the branch at the start point and checks it out', async () => {
    const base = commit('a');
    await createStackSliceBranch({ worktree: dir, branch: 'factory/1-slice-1', startPoint: 'main' });
    expect(git('rev-parse', '--abbrev-ref', 'HEAD')).toBe('factory/1-slice-1');
    expect(git('rev-parse', 'HEAD')).toBe(base);
  });

  it('resets an existing branch to the start point on rerun', async () => {
    const base = commit('a');
    await createStackSliceBranch({ worktree: dir, branch: 'b', startPoint: 'main' });
    commit('b');
    await createStackSliceBranch({ worktree: dir, branch: 'b', startPoint: 'main' });
    expect(git('rev-parse', 'b')).toBe(base);
  });

  it('rejects an unknown start point', async () => {
    commit('a');
    await expect(createStackSliceBranch({ worktree: dir, branch: 'b', startPoint: 'nope' })).rejects.toThrow();
  });
});
