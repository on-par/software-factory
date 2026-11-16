import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createTempWorktrees } from './temp-worktree.js';

describe('createTempWorktrees', () => {
  it('writes the file map, creating nested directories', async () => {
    const { makeWorktree, cleanup } = createTempWorktrees('temp-worktree-test-');
    try {
      const dir = await makeWorktree({ 'a.txt': 'a', 'deep/er/b.txt': 'b' });
      expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('a');
      expect(readFileSync(join(dir, 'deep/er/b.txt'), 'utf8')).toBe('b');
      expect(existsSync(await makeWorktree())).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('cleanup removes every worktree it made', async () => {
    const { makeWorktree, cleanup } = createTempWorktrees('temp-worktree-test-');
    const first = await makeWorktree({ 'x.txt': 'x' });
    const second = await makeWorktree();
    await cleanup();
    expect(existsSync(first)).toBe(false);
    expect(existsSync(second)).toBe(false);
  });
});
