// packages/core/src/phases/ship-no-protection.test.ts — a repo with no required checks logs the fallback warning once (#3208)

import { describe, expect, it, vi } from 'vitest';

import { shipPhase } from './ship.js';

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const remote = async (command: string) => {
  if (command === 'git rev-parse HEAD') return { stdout: `${SHA}\n` };
  if (command.startsWith('git ls-remote --heads origin')) return { stdout: `${SHA}\trefs/heads/ship-it/123-x\n` };
  return { stdout: '' };
};

const notFound = () => Object.assign(new Error('Not Found'), { status: 404 });
const green = [
  { name: 'lint', status: 'completed', conclusion: 'success' },
  { name: 'test', status: 'completed', conclusion: 'success' },
];

const octokit: any = {
  graphql: async () => ({ markPullRequestReadyForReview: { pullRequest: { isDraft: false } } }),
  rest: {
    pulls: {
      list: async () => ({ data: [{ number: 123 }] }),
      get: async () => ({ data: { draft: false, node_id: 'PR_1' } }),
    },
    issues: {
      get: async () => ({ data: { title: 'No protection' } }),
      createComment: async () => ({ data: { id: 1 } }),
    },
    checks: { listForRef: async () => ({ data: { check_runs: green } }) },
    repos: {
      getStatusChecksProtection: async () => {
        throw notFound();
      },
      getBranchRules: async () => ({ data: [] }),
      getContent: async () => ({ data: [{ type: 'file' }] }),
      getCombinedStatusForRef: async () => ({ data: { total_count: 0, statuses: [], sha: 'deadbeef' } }),
    },
  },
};

describe('ship with no required checks (#3208)', () => {
  it('gates on all checks on head and logs the no-branch-protection warning once across two PRs', async () => {
    const logs: Array<[string, string]> = [];
    vi.useFakeTimers();
    try {
      for (let i = 0; i < 2; i++) {
        const promise = shipPhase({
          issue: 123,
          repo: 'on-par/unprotected-repo',
          worktree: '/repo-factory-123',
          branch: 'ship-it/123-x',
          octokit,
          watchCI: true,
          log: (type, msg) => logs.push([type, msg]),
          run: remote,
        });
        await vi.runAllTimersAsync();
        expect(await promise).toEqual({ ok: true, prNumber: 123, ciOutcome: 'success' });
      }
    } finally {
      vi.useRealTimers();
    }
    expect(logs.filter(([type]) => type === 'warn')).toEqual([
      ['warn', 'no branch protection on on-par/unprotected-repo@main; using all checks on head'],
    ]);
  });
});
