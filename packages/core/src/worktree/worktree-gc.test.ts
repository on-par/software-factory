import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';

import { sweepWorktrees } from './worktree-gc.js';

describe('sweepWorktrees and an in-place checkout (#3904)', () => {
  const dirs = createTempDirs();
  afterEach(() => dirs.cleanup());

  it('never selects the repo root even when it is on a factory lane branch', async () => {
    const repoRoot = join(dirs.makeSync('gc-in-place-'), 'repo');
    mkdirSync(repoRoot, { recursive: true });
    writeFileSync(join(repoRoot, '.git'), 'gitdir: /somewhere');
    const commands: string[] = [];
    const runCommand = async (cmd: string) => {
      commands.push(cmd);
      if (cmd === 'git worktree list --porcelain') {
        return { stdout: `worktree ${repoRoot}\nHEAD aaa\nbranch refs/heads/factory/3904-x\n\n` };
      }
      return { stdout: '' };
    };

    const report = await sweepWorktrees({ repoRoot, ttlDays: 0 }, { runCommand });

    expect(report.removed).toHaveLength(0);
    expect(commands.some((c) => c.includes('worktree remove') || c.includes('branch -D'))).toBe(false);
  });
});
