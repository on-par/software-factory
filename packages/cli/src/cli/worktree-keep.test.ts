// packages/cli/src/cli/worktree-keep.test.ts — `factory worktree keep|release` end to end through the program and the sweep (#3318)

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { createTempDirs } from '@on-par/factory-core/testing';
import { formatGcReport, sweepWorktrees } from '@on-par/factory-core/internal';
import { afterEach, describe, expect, it } from 'vitest';

import { buildProgram } from './program.js';
import { PROGRAM_HANDLERS } from './index.js';
import { releaseKeepOnRequeue, runWorktreeKeep, runWorktreeRelease, type WorktreeKeepDeps } from './worktree-keep.js';

const readWorktreeKeeps = (file: string): { issue: number; reason: string }[] =>
  existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];

describe('factory worktree keep / release', () => {
  const tmp = createTempDirs();
  afterEach(() => tmp.cleanup());

  function setup(issue = 4242) {
    const parent = tmp.makeSync('wt-keep-');
    const root = join(parent, 'repo');
    mkdirSync(root, { recursive: true });
    const wt = join(parent, `${basename(root)}-factory-ship-it-${issue}`);
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, '.git'), 'gitdir: /somewhere');
    const keepsFile = join(parent, 'worktree-keeps.json');
    const lines: string[] = [];
    const deps: WorktreeKeepDeps = {
      keepsFile,
      worktreePath: () => wt,
      now: () => new Date('2026-10-22T00:00:00Z'),
      out: (l) => lines.push(l),
    };
    const program = buildProgram(
      {
        ...PROGRAM_HANDLERS,
        cmdWorktreeKeep: (i: string, opts: any) => runWorktreeKeep(Number(i), opts, deps),
        cmdWorktreeRelease: (i: string) => runWorktreeRelease(Number(i), deps).then(() => {}),
      },
      {},
    );
    program.exitOverride();
    const run = (...args: string[]) => program.parseAsync(['node', 'factory', 'worktree', ...args]);
    return { root, wt, keepsFile, lines, deps, run };
  }

  function sweep(root: string, wt: string, keepsFile: string) {
    const runCommand = async (cmd: string) => {
      if (cmd === 'git worktree list --porcelain') {
        return {
          stdout: `worktree ${root}\nHEAD aaa\nbranch refs/heads/main\n\nworktree ${wt}\nHEAD bbb\nbranch refs/heads/ship-it/4242-x\n\n`,
        };
      }
      if (cmd.startsWith('git worktree remove')) rmSync(wt, { recursive: true, force: true });
      return { stdout: '' };
    };
    const octokit = {
      rest: {
        pulls: { list: async () => ({ data: [] }) },
        issues: { get: async () => ({ data: { state: 'open', labels: [{ name: 'factory:parked' }] } }) },
      },
    } as any;
    return sweepWorktrees({ repoRoot: root, ttlDays: 7, repo: 'o/r', keepsFile }, { runCommand, octokit });
  }

  it('factory worktree keep protects a manual finish from the sweep (#3264, 2026-10-19)', async () => {
    const { root, wt, keepsFile, run } = setup();
    await run('keep', '4242', '--reason', 'finishing');
    const report = await sweep(root, wt, keepsFile);
    expect(report.removed).toEqual([]);
    expect(existsSync(wt)).toBe(true);
    expect(formatGcReport(report)).toContain('kept (finishing)');
  });

  it('factory worktree release lets the next sweep reap the parked worktree as issue-parked', async () => {
    const { root, wt, keepsFile, lines, run } = setup();
    await run('keep', '4242');
    await run('release', '4242');
    expect(lines[1]).toContain('released the keep record for #4242');
    const report = await sweep(root, wt, keepsFile);
    expect(report.removed[0].reason).toBe('issue-parked');
    expect(readWorktreeKeeps(keepsFile)).toEqual([]);
  });

  it('keep defaults the reason to manual', async () => {
    const { keepsFile, run } = setup();
    await run('keep', '4242');
    expect(readWorktreeKeeps(keepsFile)[0].reason).toBe('manual');
  });

  it('worktree release with no record says so and never creates the keeps file', async () => {
    const { keepsFile, lines, run } = setup();
    await run('release', '4242');
    expect(lines[0]).toContain('no keep record');
    expect(existsSync(keepsFile)).toBe(false);
  });

  it('worktree keep exits 2 when the issue has no lane worktree', async () => {
    const { keepsFile, deps } = setup();
    const err = await runWorktreeKeep(4242, {}, { ...deps, pathExists: () => false }).catch((e) => e);
    expect(err).toMatchObject({ name: 'CliExitError', code: 2 });
    expect(existsSync(keepsFile)).toBe(false);
  });

  it('worktree keep exits 2 on an empty --reason', async () => {
    const { keepsFile, deps } = setup();
    const err = await runWorktreeKeep(4242, { reason: '  ' }, deps).catch((e) => e);
    expect(err).toMatchObject({ name: 'CliExitError', code: 2 });
    expect(existsSync(keepsFile)).toBe(false);
  });

  it('releaseKeepOnRequeue is a no-op for an undefined file and swallows a throw', () => {
    expect(() => releaseKeepOnRequeue(undefined, 1)).not.toThrow();
    const warnings: string[] = [];
    const dir = tmp.makeSync('wt-keep-bad-');
    // A directory where the keeps file should be makes the removal throw.
    expect(() => releaseKeepOnRequeue(dir, 1, (m) => warnings.push(m))).not.toThrow();
  });
});
