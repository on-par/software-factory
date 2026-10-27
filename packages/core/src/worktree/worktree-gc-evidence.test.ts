import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import { createEvidenceContext, defaultRunCommand, gatherWorktreeEvidence } from './worktree-gc-evidence.js';
import { IssueWarnDedup } from './worktree-gc-types.js';
import { sweepWorktrees } from './worktree-gc.js';

const PORCELAIN = [1, 2, 3]
  .map((n) => `worktree /nonexistent/repo-factory-${n}\nHEAD h${n}\nbranch refs/heads/ship-it/7-w${n}\n`)
  .join('\n');

function fakes() {
  const issuesGet = vi.fn().mockResolvedValue({ data: { state: 'open', labels: [] } });
  const pullsList = vi.fn().mockResolvedValue({ data: [{ state: 'closed', merged_at: '2024-01-01T00:00:00Z' }] });
  const octokit = { rest: { issues: { get: issuesGet }, pulls: { list: pullsList } } } as never;
  const runCommand = vi.fn(async (cmd: string) => {
    if (cmd.startsWith('git worktree list')) return { stdout: PORCELAIN };
    if (cmd.startsWith('git rev-parse --verify origin/main')) return { stdout: 'main-tip\n' };
    return { stdout: '' };
  });
  return { issuesGet, pullsList, octokit, runCommand };
}

describe('sweep issue lookups', () => {
  it('calls issues.get once for three worktrees of the same issue in a dry-run sweep that consults disposition, existence and claim', async () => {
    const { issuesGet, octokit, runCommand } = fakes();
    const report = await sweepWorktrees(
      { repoRoot: '/nonexistent/repo', ttlDays: 7, dryRun: true, repo: 'o/r' },
      { runCommand, octokit, issueWarnDedup: new IssueWarnDedup() },
    );
    expect(issuesGet).toHaveBeenCalledTimes(1);
    expect(report.noActiveClaim).toHaveLength(3);
  });
});

describe('gatherWorktreeEvidence', () => {
  it('makes no GitHub call for a protected entry in real mode', async () => {
    const { issuesGet, pullsList, octokit, runCommand } = fakes();
    const ctx = createEvidenceContext(
      {
        repoRoot: '/nonexistent/repo',
        repo: 'o/r',
        dryRun: false,
        lanePattern: /^ship-it\/(\d+)-/,
        protectedIssues: new Set([7]),
        keeps: new Map(),
        mainTip: null,
      },
      { runCommand, now: () => 0, log: () => {}, octokit, issueWarnDedup: new IssueWarnDedup() },
    );
    const e = await gatherWorktreeEvidence(ctx, {
      path: '/nonexistent/repo-factory-1',
      head: 'h',
      branch: 'ship-it/7-w',
    });
    expect(e.protected).toBe(true);
    expect(issuesGet).not.toHaveBeenCalled();
    expect(pullsList).not.toHaveBeenCalled();
    expect(runCommand).not.toHaveBeenCalled();
  });
});

describe('defaultRunCommand', () => {
  it('runs the command as git argv with no shell and no prompts', async () => {
    const runGit = vi.fn().mockResolvedValue({ stdout: 'out', stderr: '' });

    const result = await defaultRunCommand("git ls-remote --heads origin 'a b'\\''c'", { cwd: '/r' }, runGit);

    expect(result).toEqual({ stdout: 'out' });
    expect(runGit).toHaveBeenCalledWith(['ls-remote', '--heads', 'origin', "a b'c"], { cwd: '/r', noPrompt: true });
  });

  it.each(['git status; rm -rf x', 'echo hi', "git 'unterminated", 'git $(x)', 'git a\\b', '', '   '])(
    'rejects %j without spawning',
    async (cmd) => {
      const runGit = vi.fn();

      await expect(defaultRunCommand(cmd, undefined, runGit)).rejects.toThrow('unsupported git command');
      expect(runGit).not.toHaveBeenCalled();
    },
  );

  it('propagates a GitTimeoutError from execGit', async () => {
    const err = Object.assign(new Error('timed out'), { name: 'GitTimeoutError' });

    await expect(defaultRunCommand('git status', undefined, vi.fn().mockRejectedValue(err))).rejects.toBe(err);
  });

  it('worktree-gc sources never import child_process', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const files = readdirSync(here)
      .filter((f) => /^worktree-gc.*\.ts$/.test(f) && !f.endsWith('.test.ts'))
      .map((f) => join(here, f));
    files.push(join(here, '..', 'utils', 'worktree-gc.ts'));

    for (const f of files) expect(readFileSync(f, 'utf8'), f).not.toMatch(/child_process|execSync|\bexec\(/);
  });
});

describe('sweep with a stalled remote', () => {
  const tempDirs = createTempDirs();
  afterEach(() => tempDirs.cleanup());

  it('keeps a worktree with reason "remote check timed out" when git ls-remote times out', async () => {
    const parentDir = tempDirs.makeSync('gc-parent-');
    const root = join(parentDir, 'repo');
    const wt = join(parentDir, `${basename(root)}-factory-ship-it-6`);
    mkdirSync(root, { recursive: true });
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, '.git'), 'gitdir: /somewhere');
    const commands: string[] = [];
    const logs: Array<[string, string]> = [];

    const runCommand = async (cmd: string) => {
      commands.push(cmd);
      if (cmd === 'git worktree list --porcelain') {
        return {
          stdout: `worktree ${root}\nHEAD aaa\nbranch refs/heads/main\n\nworktree ${wt}\nHEAD bbb\nbranch refs/heads/ship-it/6-feature\n\n`,
        };
      }
      if (cmd.startsWith('git merge-base --is-ancestor')) throw new Error('exit 1');
      if (cmd.startsWith('git ls-remote')) {
        throw Object.assign(new Error('git command timed out after 120000ms'), { name: 'GitTimeoutError' });
      }
      if (cmd.includes('rev-parse --verify --quiet')) return { stdout: 'bbb\n' };
      return { stdout: '' };
    };

    const report = await sweepWorktrees(
      { repoRoot: root, ttlDays: 7 },
      { runCommand, log: (type, msg) => logs.push([type, msg]) },
    );

    expect(report.removed).toHaveLength(0);
    expect(report.held).toEqual([expect.objectContaining({ issue: 6, why: 'remote check timed out' })]);
    expect(logs.some(([t, m]) => t === 'warn' && m.includes('remote check timed out'))).toBe(true);
    expect(commands.some((c) => c.includes('worktree remove'))).toBe(false);
  });
});
