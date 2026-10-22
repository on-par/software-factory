import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { formatGcReport, sweepWorktrees } from './worktree-gc.js';
import type { SweepDeps } from './worktree-gc.js';
import { readWorktreeKeeps, upsertWorktreeKeep } from './worktree-keeps.js';
import { createTempDirs } from '../harness/temp-dir.js';

describe('sweepWorktrees honors worktree-keeps.json (#3316)', () => {
  const tmp = createTempDirs();
  let parentDir: string;
  afterEach(() => tmp.cleanup());

  function setup(issue = 3264) {
    parentDir = tmp.makeSync('gc-keeps-');
    const root = join(parentDir, 'repo');
    mkdirSync(root, { recursive: true });
    const wt = join(parentDir, `${basename(root)}-factory-ship-it-${issue}`);
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, '.git'), 'gitdir: /somewhere');
    const keepsFile = join(parentDir, 'worktree-keeps.json');
    return { root, wt, keepsFile, issue };
  }

  interface SweepOctokitDouble {
    rest: {
      pulls: { list: (args: any) => Promise<any> };
      issues: { get: (args: any) => Promise<any> };
    };
  }

  function octokitFor(state: 'open' | 'closed', labels: string[]): NonNullable<SweepDeps['octokit']> {
    const double: SweepOctokitDouble = {
      rest: {
        pulls: { list: async () => ({ data: [] }) },
        issues: { get: async () => ({ data: { state, labels: labels.map((name) => ({ name })) } }) },
      },
    };
    return double as NonNullable<SweepDeps['octokit']>;
  }

  function runner(root: string, wt: string, branch: string, dirty = false) {
    return async (cmd: string) => {
      if (cmd === 'git worktree list --porcelain') {
        return {
          stdout: `worktree ${root}\nHEAD aaa\nbranch refs/heads/main\n\nworktree ${wt}\nHEAD bbb\nbranch refs/heads/${branch}\n\n`,
        };
      }
      if (cmd.startsWith('git worktree remove')) rmSync(wt, { recursive: true, force: true });
      if (dirty && cmd.includes('status')) return { stdout: ' M file\n' };
      return { stdout: '' };
    };
  }

  const keepRecord = (issue: number, wt: string) => ({ issue, path: wt, reason: 'budget_exceeded', since: 'now' });

  it('a kept parked worktree survives the between-issue sweep (#3264, 2026-10-19)', async () => {
    const { root, wt, keepsFile, issue } = setup();
    upsertWorktreeKeep(keepsFile, keepRecord(issue, wt));
    const report = await sweepWorktrees(
      { repoRoot: root, ttlDays: 7, repo: 'o/r', keepsFile },
      { runCommand: runner(root, wt, 'ship-it/3264-x'), octokit: octokitFor('open', ['factory:parked']) },
    );
    expect(report.removed).toEqual([]);
    expect(existsSync(wt)).toBe(true);
    expect(report.kept).toBeGreaterThanOrEqual(1);
    expect(formatGcReport(report)).toContain('kept (budget_exceeded)');
  });

  it('a kept worktree older than gcTtlDays is not removed as ttl-expired', async () => {
    const { root, wt, keepsFile, issue } = setup();
    upsertWorktreeKeep(keepsFile, keepRecord(issue, wt));
    const old = new Date(Date.now() - 30 * 86_400_000);
    utimesSync(join(wt, '.git'), old, old);
    const report = await sweepWorktrees(
      { repoRoot: root, ttlDays: 1, repo: 'o/r', keepsFile },
      { runCommand: runner(root, wt, 'ship-it/3264-x'), octokit: octokitFor('open', []) },
    );
    expect(report.removed).toEqual([]);
    expect(existsSync(wt)).toBe(true);
  });

  it('a kept worktree whose issue closed is removed as issue-closed and its keep record is deleted', async () => {
    const { root, wt, keepsFile, issue } = setup();
    upsertWorktreeKeep(keepsFile, keepRecord(issue, wt));
    upsertWorktreeKeep(keepsFile, keepRecord(1, '/other'));
    const report = await sweepWorktrees(
      { repoRoot: root, ttlDays: 7, repo: 'o/r', keepsFile },
      { runCommand: runner(root, wt, 'ship-it/3264-x'), octokit: octokitFor('closed', []) },
    );
    expect(report.removed[0].reason).toBe('issue-closed');
    expect(readWorktreeKeeps(keepsFile).map((k) => k.issue)).toEqual([1]);
  });

  it('a dry run of the closed case keeps the record', async () => {
    const { root, wt, keepsFile, issue } = setup();
    upsertWorktreeKeep(keepsFile, keepRecord(issue, wt));
    const report = await sweepWorktrees(
      { repoRoot: root, ttlDays: 7, repo: 'o/r', keepsFile, dryRun: true },
      { runCommand: runner(root, wt, 'ship-it/3264-x'), octokit: octokitFor('closed', []) },
    );
    expect(report.removed[0].reason).toBe('issue-closed');
    expect(readWorktreeKeeps(keepsFile)).toHaveLength(1);
  });

  it('a dry run of the parked case lists the kept worktree', async () => {
    const { root, wt, keepsFile, issue } = setup();
    upsertWorktreeKeep(keepsFile, keepRecord(issue, wt));
    const report = await sweepWorktrees(
      { repoRoot: root, ttlDays: 7, repo: 'o/r', keepsFile, dryRun: true },
      { runCommand: runner(root, wt, 'ship-it/3264-x'), octokit: octokitFor('open', ['factory:parked']) },
    );
    expect(report.keptByRecord).toHaveLength(1);
    expect(formatGcReport(report)).toContain('(ship-it/3264-x) — kept (budget_exceeded)');
  });

  it('keeps a closed issue whose tree is dirty', async () => {
    const { root, wt, keepsFile, issue } = setup();
    upsertWorktreeKeep(keepsFile, keepRecord(issue, wt));
    const report = await sweepWorktrees(
      { repoRoot: root, ttlDays: 7, repo: 'o/r', keepsFile },
      { runCommand: runner(root, wt, 'ship-it/3264-x', true), octokit: octokitFor('closed', []) },
    );
    expect(report.removed).toEqual([]);
    expect(existsSync(wt)).toBe(true);
  });

  it('still removes a candidate with no record as issue-parked', async () => {
    const { root, wt, keepsFile } = setup();
    const report = await sweepWorktrees(
      { repoRoot: root, ttlDays: 7, repo: 'o/r', keepsFile },
      { runCommand: runner(root, wt, 'ship-it/3264-x'), octokit: octokitFor('open', ['factory:parked']) },
    );
    expect(report.removed[0].reason).toBe('issue-parked');
  });

  describe('untracked files (#3318)', () => {
    const untrackedRunner = (root: string, wt: string, status: string) => {
      const base = runner(root, wt, 'ship-it/3264-x');
      return async (cmd: string) => (cmd.includes('--untracked-files=normal') ? { stdout: status } : base(cmd));
    };

    it('an unkept parked worktree with an untracked file is held and listed as held (untracked files)', async () => {
      const { root, wt, keepsFile } = setup();
      const messages: string[] = [];
      const report = await sweepWorktrees(
        { repoRoot: root, ttlDays: 7, repo: 'o/r', keepsFile },
        {
          runCommand: untrackedRunner(root, wt, '?? NEW.txt\n'),
          octokit: octokitFor('open', ['factory:parked']),
          log: (type, msg) => {
            if (type === 'worktree-gc') messages.push(msg);
          },
        },
      );
      expect(report.removed).toEqual([]);
      expect(existsSync(wt)).toBe(true);
      expect(report.heldUntracked?.[0].path).toBe(wt);
      expect(formatGcReport(report)).toContain('held (untracked files)');
      expect(messages.some((m) => m.includes(wt))).toBe(true);
    });

    it('an unkept parked worktree with only ignored/no untracked files is still reaped as issue-parked', async () => {
      const { root, wt, keepsFile } = setup();
      const report = await sweepWorktrees(
        { repoRoot: root, ttlDays: 7, repo: 'o/r', keepsFile },
        { runCommand: untrackedRunner(root, wt, ''), octokit: octokitFor('open', ['factory:parked']) },
      );
      expect(report.removed[0].reason).toBe('issue-parked');
    });

    it('a held untracked parked worktree older than gcTtlDays is not removed as ttl-expired', async () => {
      const { root, wt, keepsFile } = setup();
      const old = new Date(Date.now() - 30 * 86_400_000);
      utimesSync(join(wt, '.git'), old, old);
      const report = await sweepWorktrees(
        { repoRoot: root, ttlDays: 1, repo: 'o/r', keepsFile },
        { runCommand: untrackedRunner(root, wt, '?? NEW.txt\n'), octokit: octokitFor('open', ['factory:parked']) },
      );
      expect(report.removed).toEqual([]);
      expect(existsSync(wt)).toBe(true);
    });
  });
});
