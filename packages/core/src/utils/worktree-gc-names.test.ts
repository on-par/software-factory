// packages/core/src/utils/worktree-gc-names.test.ts — GC ownership of deduped lane names (#2763).
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { sweepWorktrees } from './worktree-gc.js';
import { legacyWorktreeDirName, worktreeDirName } from './worktree-name.js';

describe('sweepWorktrees lane names', () => {
  let parentDir: string;

  function makeWorktree(name: string, ageMs?: number): string {
    const path = join(parentDir, name);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, '.git'), 'gitdir: /somewhere');
    if (ageMs !== undefined) {
      const past = new Date(Date.now() - ageMs);
      utimesSync(join(path, '.git'), past, past);
    }
    return path;
  }

  afterEach(() => rmSync(parentDir, { recursive: true, force: true }));

  it('recognises old and new lane worktree names, including a detached new-style one, but not a manual branch (#2763)', async () => {
    parentDir = mkdtempSync(join(tmpdir(), 'gc-parent-'));
    const root = join(parentDir, 'software-factory');
    mkdirSync(root, { recursive: true });
    const newWt = makeWorktree(worktreeDirName(basename(root), 31, 'factory'), 30 * 24 * 60 * 60 * 1000);
    const oldWt = makeWorktree(legacyWorktreeDirName(basename(root), 32, 'factory'));
    const manualWt = makeWorktree(worktreeDirName(basename(root), 33, 'factory'));
    expect(basename(newWt)).toBe('software-factory-31');

    const runCommand = async (cmd: string) => {
      if (cmd === 'git worktree list --porcelain') {
        return {
          stdout:
            `worktree ${root}\nHEAD aaa\nbranch refs/heads/main\n\n` +
            `worktree ${newWt}\nHEAD bbb\ndetached\n\n` +
            `worktree ${oldWt}\nHEAD bbb\nbranch refs/heads/factory/32-x\n\n` +
            `worktree ${manualWt}\nHEAD bbb\nbranch refs/heads/manual/5-x\n\n`,
        };
      }
      if (cmd === 'git rev-parse --verify origin/main') return { stdout: 'aaa\n' };
      if (cmd.startsWith('git merge-base --is-ancestor')) return { stdout: '' };
      if (cmd.includes('rev-parse --verify --quiet')) return { stdout: 'bbb\n' };
      return { stdout: '' };
    };

    const report = await sweepWorktrees({ repoRoot: root, ttlDays: 7, branchPrefix: 'factory' }, { runCommand });
    expect(report.removed.map((r) => r.path).sort()).toEqual([newWt, oldWt].sort());
    expect(existsSync(manualWt)).toBe(true);
  });
});
