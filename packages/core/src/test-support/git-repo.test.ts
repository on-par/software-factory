import { execFileSync } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import { makeRepo } from './git-repo.js';

const dirs = createTempDirs();

afterEach(async () => {
  await dirs.cleanup();
});

describe('makeRepo', () => {
  it('commits the file map on a fresh repo with a clean tree', () => {
    const repo = makeRepo(dirs, 'git-repo-test-', { 'a.txt': 'one', 'sub/b.txt': 'two' }, 'seed');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
    expect(git('show', 'HEAD:a.txt')).toBe('one');
    expect(git('show', 'HEAD:sub/b.txt')).toBe('two');
    expect(git('status', '--porcelain')).toBe('');
    expect(git('log', '-1', '--format=%s').trim()).toBe('seed');
  });
});
