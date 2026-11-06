// Already-quarantined worktrees are never moved again, and still drain on hard evidence (#3966).
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SweepDeps } from './worktree-gc.js';
import { quarantineDestination, sweepWorktrees } from './worktree-gc.js';

/** The only endpoints sweepWorktrees reaches; a structural supertype of Pick<Octokit,'rest'>. */
interface SweepOctokitDouble {
  rest: {
    pulls: { list: (args: any) => Promise<any> };
    issues: { get: (args: any) => Promise<any> };
  };
}

describe('already-quarantined worktrees (#3966)', () => {
  let parentDir = '';

  afterEach(() => {
    if (parentDir) rmSync(parentDir, { recursive: true, force: true });
  });

  function setup() {
    parentDir = mkdtempSync(join(tmpdir(), 'gc-parent-'));
    const repoRoot = join(parentDir, 'repo');
    mkdirSync(repoRoot, { recursive: true });
    return { repoRoot };
  }

  function quarantined(root: string, name: string): string {
    const path = join(root, '.factory', 'state', 'quarantine', name);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, '.git'), 'gitdir: /somewhere');
    return path;
  }

  function fakeOctokit(
    result: () => { data: Array<Record<string, unknown>> },
    issueResult: () => { data: Record<string, unknown> } = () => ({ data: { state: 'open', labels: [] } }),
  ) {
    const double: SweepOctokitDouble = {
      rest: { pulls: { list: vi.fn(async () => result()) }, issues: { get: vi.fn(async () => issueResult()) } },
    };
    return double as NonNullable<SweepDeps['octokit']>;
  }

  const notFound = () => {
    throw Object.assign(new Error('Not Found'), { status: 404 });
  };

  /** `merged` answers like a branch whose HEAD is behind main; otherwise a live, pushed branch. */
  function runner(root: string, wt: string, branch: string, merged = false) {
    const commands: string[] = [];
    const runCommand = async (cmd: string) => {
      commands.push(cmd);
      if (cmd === 'git worktree list --porcelain') {
        return {
          stdout: `worktree ${root}\nHEAD aaa\nbranch refs/heads/main\n\nworktree ${wt}\nHEAD bbb\nbranch refs/heads/${branch}\n\n`,
        };
      }
      if (cmd === 'git rev-parse --verify origin/main') return { stdout: merged ? 'aaa\n' : 'bbb\n' };
      if (cmd.startsWith('git ls-remote --heads origin')) return { stdout: `bbb\trefs/heads/${branch}\n` };
      if (
        merged &&
        (cmd.includes('rev-parse --verify --quiet') ||
          cmd.startsWith('git reflog show') ||
          cmd.startsWith('git config --get'))
      ) {
        throw new Error('no local evidence');
      }
      return { stdout: '' };
    };
    return { commands, runCommand };
  }

  const opts = (root: string) => ({ repoRoot: root, ttlDays: 7, repo: 'owner/example-app' });

  it('quarantineDestination returns the current path for an already-quarantined worktree (#3966)', () => {
    const { repoRoot: root } = setup();
    const wt = quarantined(root, `${basename(root)}-factory-ship-it-70`);
    const qdir = join(root, '.factory', 'state', 'quarantine');
    expect(quarantineDestination(qdir, wt)).toBe(resolve(wt));
  });

  it('quarantineDestination collapses prior epoch suffixes to one on collision (#3966)', () => {
    const { repoRoot: root } = setup();
    const qdir = join(root, '.factory', 'state', 'quarantine');
    const base = 'foo-factory-ship-it-9-1700000000000-1700000000001';
    mkdirSync(join(qdir, base), { recursive: true });
    const dest = quarantineDestination(qdir, join(parentDir, base));
    expect(basename(dest)).toMatch(/^foo-factory-ship-it-9-\d{13}$/);
  });

  it('keeps an already-quarantined worktree instead of moving it again (#3966)', async () => {
    const { repoRoot: root } = setup();
    const wt = quarantined(root, `${basename(root)}-factory-ship-it-71`);
    const { commands, runCommand } = runner(root, wt, 'factory/71-ghost');
    const logs: Array<[string, string]> = [];
    const report = await sweepWorktrees(opts(root), {
      runCommand,
      octokit: fakeOctokit(() => ({ data: [] }), notFound),
      log: (type, msg) => logs.push([type, msg]),
    });
    expect(report.removed).toEqual([]);
    expect(report.kept).toBe(1);
    expect(commands.some((c) => c.includes('worktree move'))).toBe(false);
    expect(logs.some(([t, m]) => t === 'warn' && /ENAMETOOLONG|manual move fallback/.test(m))).toBe(false);
  });

  it('repeated sweeps leave an already-quarantined basename unchanged (#3966)', async () => {
    const { repoRoot: root } = setup();
    const name = `${basename(root)}-factory-ship-it-72`;
    const wt = quarantined(root, name);
    for (let i = 0; i < 3; i++) {
      const { runCommand } = runner(root, wt, 'factory/72-ghost');
      await sweepWorktrees(opts(root), { runCommand, octokit: fakeOctokit(() => ({ data: [] }), notFound) });
    }
    const qdir = join(root, '.factory', 'state', 'quarantine');
    expect(existsSync(join(qdir, name))).toBe(true);
    expect(readdirSync(qdir)).toEqual([name]);
  });

  it('removes an already-quarantined clean worktree whose PR merged (#3966)', async () => {
    const { repoRoot: root } = setup();
    const wt = quarantined(root, `${basename(root)}-factory-ship-it-73`);
    const { commands, runCommand } = runner(root, wt, 'factory/73-merged', true);
    const octokit = fakeOctokit(() => ({
      data: [{ number: 1, state: 'closed', merged_at: '2026-08-14T00:00:00Z' }],
    }));
    const report = await sweepWorktrees(opts(root), { runCommand, octokit });
    expect(report.removed).toHaveLength(1);
    expect(report.removed[0].reason).toBe('merged');
    expect(report.removed[0].action).toBe('remove');
    expect(commands.some((c) => c.includes('worktree remove') && c.includes(wt))).toBe(true);
  });

  it('keeps an already-quarantined worktree with an open PR (#3966)', async () => {
    const { repoRoot: root } = setup();
    const wt = quarantined(root, `${basename(root)}-factory-ship-it-74`);
    const { commands, runCommand } = runner(root, wt, 'factory/74-open', true);
    const octokit = fakeOctokit(() => ({ data: [{ number: 5, state: 'open' }] }));
    const report = await sweepWorktrees(opts(root), { runCommand, octokit });
    expect(report.removed).toEqual([]);
    expect(report.kept).toBe(1);
    expect(commands.some((c) => c.includes('worktree move') || c.includes('worktree remove'))).toBe(false);
  });
});
