import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { CLAIMED_BY_LABEL_PREFIX, claimExpiresLabel } from '../queue/github-queue.js';
import { isZeroCommitLane, sweepWorktrees } from './worktree-gc.js';
import type { SweepDeps } from './worktree-gc.js';

describe('sweepWorktrees in-flight lanes, claims and zero-commit branches (#2964)', () => {
  let parentDir: string;

  function makeWorktree(name: string): string {
    const path = join(parentDir, name);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, '.git'), 'gitdir: /somewhere');
    return path;
  }

  function setup() {
    parentDir = mkdtempSync(join(tmpdir(), 'gc-parent-'));
    const repoRoot = join(parentDir, 'repo');
    mkdirSync(repoRoot, { recursive: true });
    return { parentDir, repoRoot };
  }

  afterEach(() => {
    if (parentDir) rmSync(parentDir, { recursive: true, force: true });
  });

  /** The only endpoints sweepWorktrees reaches; a structural supertype so one assertion suffices. */
  interface SweepOctokitDouble {
    rest: {
      pulls: { list: (args: any) => Promise<any> };
      issues: { get: (args: any) => Promise<any> };
    };
  }

  function asSweepOctokit(double: SweepOctokitDouble): NonNullable<SweepDeps['octokit']> {
    return double as NonNullable<SweepDeps['octokit']>;
  }

  function fakeOctokit(
    result: () => { data: Array<Record<string, unknown>> },
    issueResult: () => { data: Record<string, unknown> } = () => ({ data: { state: 'open', labels: [] } }),
  ) {
    const double = {
      rest: {
        pulls: { list: vi.fn(async (_params: unknown) => result()) },
        issues: { get: vi.fn(async (_params: unknown) => issueResult()) },
      },
    };
    const octokit = asSweepOctokit(double);
    return { octokit };
  }

  function rig(n: number, ahead: string) {
    const { repoRoot: root } = setup();
    const wt = makeWorktree(`${basename(root)}-factory-ship-it-${n}`);
    const commands: string[] = [];
    const runCommand = async (cmd: string) => {
      commands.push(cmd);
      if (cmd === 'git worktree list --porcelain') {
        return {
          stdout: `worktree ${root}\nHEAD aaa\nbranch refs/heads/main\n\nworktree ${wt}\nHEAD bbb\nbranch refs/heads/ship-it/${n}-lane\n\n`,
        };
      }
      if (cmd === 'git rev-parse --verify origin/main') return { stdout: 'aaa\n' };
      if (cmd.startsWith('git rev-list --count origin/main..')) return { stdout: ahead };
      return { stdout: '' };
    };
    const removedCmds = () =>
      commands.filter((c) => c.startsWith('git worktree remove') || c.startsWith('git branch -D'));
    return { root, runCommand, removedCmds };
  }
  const closedPr = () => ({ data: [{ number: 1, state: 'closed', merged_at: null }] });
  const mergedPr = () => ({ data: [{ number: 1, state: 'closed', merged_at: '2026-08-14T00:00:00Z' }] });

  it('keeps a zero-commit lane worktree whose issue is in protectedIssues even with a closed PR on its branch (#2964)', async () => {
    const { root, runCommand, removedCmds } = rig(31, '0\n');
    const { octokit } = fakeOctokit(closedPr);
    const report = await sweepWorktrees(
      { repoRoot: root, ttlDays: 7, repo: 'owner/example-app', protectedIssues: new Set([31]) },
      { runCommand, octokit },
    );
    expect(report.removed).toEqual([]);
    expect(report.kept).toBe(1);
    expect(removedCmds()).toEqual([]);
  });

  it('keeps a merged-PR worktree whose open issue carries an active claim label (#2964)', async () => {
    const { root, runCommand } = rig(32, '3\n');
    const { octokit } = fakeOctokit(mergedPr, () => ({
      data: { state: 'open', labels: [`${CLAIMED_BY_LABEL_PREFIX}lane-a`] },
    }));
    const report = await sweepWorktrees(
      { repoRoot: root, ttlDays: 7, repo: 'owner/example-app' },
      { runCommand, octokit },
    );
    expect(report.removed).toEqual([]);
    expect(report.kept).toBe(1);
  });

  it('keeps a TTL-expired worktree whose open issue carries an active claim label (#2964)', async () => {
    const { root, runCommand } = rig(33, '3\n');
    const { octokit } = fakeOctokit(
      () => ({ data: [] }),
      () => ({ data: { state: 'open', labels: [`${CLAIMED_BY_LABEL_PREFIX}lane-a`] } }),
    );
    const report = await sweepWorktrees(
      { repoRoot: root, ttlDays: 7, repo: 'owner/example-app' },
      { runCommand, octokit, now: () => Date.now() + 365 * 86_400_000 },
    );
    expect(report.removed).toEqual([]);
    expect(report.kept).toBe(1);
  });

  it('still reaps when the claim label lease has expired (#2964)', async () => {
    const { root, runCommand } = rig(34, '3\n');
    const expired = claimExpiresLabel(Math.floor(Date.now() / 1000) - 3600);
    const { octokit } = fakeOctokit(mergedPr, () => ({
      data: { state: 'open', labels: [`${CLAIMED_BY_LABEL_PREFIX}lane-a`, expired] },
    }));
    const report = await sweepWorktrees(
      { repoRoot: root, ttlDays: 7, repo: 'owner/example-app' },
      { runCommand, octokit },
    );
    expect(report.removed.map((c) => c.reason)).toEqual(['merged']);
  });

  it('does not reap a zero-commit branch as merged when an older closed PR exists for its name (#2964)', async () => {
    const { root, runCommand, removedCmds } = rig(35, '0\n');
    const { octokit } = fakeOctokit(closedPr);
    const report = await sweepWorktrees(
      { repoRoot: root, ttlDays: 7, repo: 'owner/example-app' },
      { runCommand, octokit },
    );
    // Never 'merged'/'remote-gone' (the unclaimed heuristic quarantine tier is unchanged).
    expect(report.removed.map((c) => c.reason)).not.toContain('merged');
    expect(report.removed.map((c) => c.reason)).not.toContain('remote-gone');
    expect(removedCmds()).toEqual([]);
  });

  it('does not reap a zero-commit branch as merged on a GitHub-merged PR verdict (#2964)', async () => {
    const { root, runCommand } = rig(36, '0\n');
    const { octokit } = fakeOctokit(mergedPr);
    const report = await sweepWorktrees(
      { repoRoot: root, ttlDays: 7, repo: 'owner/example-app' },
      { runCommand, octokit },
    );
    expect(report.removed.map((c) => c.reason)).not.toContain('merged');
    expect(report.removed.map((c) => c.reason)).not.toContain('remote-gone');
  });

  it('still removes a squash-merged unclaimed lane with commits ahead of main (#2964)', async () => {
    const { root, runCommand } = rig(37, '3\n');
    const { octokit } = fakeOctokit(mergedPr);
    const report = await sweepWorktrees(
      { repoRoot: root, ttlDays: 7, repo: 'owner/example-app' },
      { runCommand, octokit },
    );
    expect(report.removed.map((c) => c.reason)).toEqual(['merged']);
  });
});

describe('isZeroCommitLane (#2964)', () => {
  it('is true only for an exact 0 count', async () => {
    expect(await isZeroCommitLane(async () => ({ stdout: '0\n', stderr: '' }), '/r', 'abc')).toBe(true);
    expect(await isZeroCommitLane(async () => ({ stdout: '2\n', stderr: '' }), '/r', 'abc')).toBe(false);
  });
  it('is false on a probe failure, empty output, or a null head', async () => {
    expect(
      await isZeroCommitLane(
        async () => {
          throw new Error('x');
        },
        '/r',
        'abc',
      ),
    ).toBe(false);
    expect(await isZeroCommitLane(async () => ({ stdout: '', stderr: '' }), '/r', 'abc')).toBe(false);
    expect(await isZeroCommitLane(async () => ({ stdout: '0', stderr: '' }), '/r', null)).toBe(false);
  });
});
