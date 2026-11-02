// packages/core/src/utils/lane-removal.test.ts — reapLaneWorktree holds a parked worktree with untracked files (#3318)
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { PipelineTestKit } from '../test-support/index.js';
import { reapLaneWorktree, setupWorktree } from './index.js';

describe('reapLaneWorktree untracked files', () => {
  const kit = new PipelineTestKit();
  afterEach(async () => {
    await kit.cleanup();
  });

  async function lane() {
    const { repoRoot } = await kit.makeThrowawayRepo();
    const worktree = kit.trackWorktree(repoRoot, 4242);
    await setupWorktree(repoRoot, 'factory/4242-x', worktree);
    return { repoRoot, worktree, keepsFile: join(repoRoot, 'keeps.json') };
  }

  it('keeps a tracked-clean worktree that has a new untracked file', async () => {
    const { repoRoot, worktree, keepsFile } = await lane();
    writeFileSync(join(worktree, 'NEW.txt'), 'manual work');
    const logs: string[] = [];
    const result = await reapLaneWorktree(repoRoot, worktree, {
      issue: 4242,
      keepsFile,
      log: (_type, msg) => logs.push(msg),
    });
    expect(result.outcome).toBe('kept-untracked');
    expect(existsSync(join(worktree, 'NEW.txt'))).toBe(true);
    expect(logs.some((m) => m.includes(worktree))).toBe(true);
  });

  it('still removes a worktree whose only extra file is gitignored', async () => {
    const { repoRoot, worktree, keepsFile } = await lane();
    writeFileSync(join(repoRoot, '.git', 'info', 'exclude'), 'ignored.txt\n', { flag: 'a' });
    writeFileSync(join(worktree, 'ignored.txt'), 'x');
    const result = await reapLaneWorktree(repoRoot, worktree, { issue: 4242, keepsFile });
    expect(result.outcome).toBe('removed');
    expect(existsSync(worktree)).toBe(false);
  });
});
