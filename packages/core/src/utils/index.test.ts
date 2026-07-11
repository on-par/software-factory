import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { slugify, shellEscape, branchFor, cleanupWorktree } from './index.js';

let tmpDir: string | undefined;

describe('utils', () => {
  afterEach(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it('slugifies text for branch-safe identifiers', () => {
    expect(slugify('Hello, World! 123')).toBe('hello-world-123');
    expect(slugify('  --Trim--  ')).toBe('trim');
    expect(slugify('a very long title that should be truncated by slugify').length).toBeLessThanOrEqual(32);
  });

  it('escapes strings for single-quoted shell arguments', () => {
    expect(shellEscape("it's")).toBe("'it'\\''s'");
    expect(shellEscape('plain')).toBe("'plain'");
  });

  it('builds a ship-it branch from issue and title, matching slugify', () => {
    expect(branchFor(22, 'Reliably detect a merged PR')).toBe(`ship-it/22-${slugify('Reliably detect a merged PR')}`);
    expect(branchFor(7, 'Hello, World!')).toBe('ship-it/7-hello-world');
  });

  it('logs worktree cleanup failures without rejecting', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'factory-cleanup-'));
    const worktreePath = join(tmpDir, 'nonexistent-wt');
    const spy = vi.fn();

    await expect(cleanupWorktree(tmpDir, worktreePath, spy)).resolves.toBeUndefined();

    expect(spy).toHaveBeenCalledWith(
      'warn',
      expect.stringContaining('nonexistent-wt'),
    );
  });
});
