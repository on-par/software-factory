import { describe, expect, it, vi } from 'vitest';

import { createEvidenceContext, gatherWorktreeEvidence } from './worktree-gc-evidence.js';
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
