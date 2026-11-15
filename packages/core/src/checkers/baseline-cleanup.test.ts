import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import type { ModelRouter } from '../router/index.js';
import { type CommandResult, runCommand } from '../utils/command-runner.js';
import { runBaselineCheckers } from './baseline.js';
import { type runAllCheckers, summarizeCheckerOutputs } from './index.js';

const tempDirs = createTempDirs();

afterEach(() => tempDirs.cleanup());

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

const refused = (argv: readonly string[]): CommandResult => ({
  command: argv,
  stdout: '',
  stderr: 'refused',
  exitCode: 1,
  killed: false,
  timedOut: false,
  ok: false,
});

describe('runBaselineCheckers cleanup', () => {
  it('deletes and prunes the base worktree when git worktree remove fails', async () => {
    const repo = await tempDirs.make('baseline-cleanup-');
    git(repo, 'init', '--initial-branch=main');
    await writeFile(join(repo, 'f.txt'), 'A');
    git(repo, 'add', '.');
    git(repo, '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-m', 'A');
    let parent = '';
    const report = await runBaselineCheckers({
      baseSha: git(repo, 'rev-parse', 'HEAD'),
      laneWorktree: repo,
      failing: [{ checker: 'tests', result: 'FAIL', details: '' }],
      ctx: { worktree: repo, specPath: '', env: {} },
      router: {} as ModelRouter,
      constitution: null,
      deps: {
        makeTempDir: async () => (parent = await tempDirs.make('baseline-cleanup-parent-')),
        runCommand: (async (argv, options) =>
          argv[2] === 'remove' ? refused(argv) : runCommand(argv, options)) as typeof runCommand,
        runCheckers: (async () =>
          summarizeCheckerOutputs([{ checker: 'tests', result: 'PASS', details: '' }])) as typeof runAllCheckers,
      },
    });
    expect(report.error).toBeUndefined();
    expect(existsSync(join(parent, 'base'))).toBe(false);
    expect(
      git(repo, 'worktree', 'list', '--porcelain')
        .split('\n')
        .filter((l) => l.startsWith('worktree ')),
    ).toHaveLength(1);
  });
});
