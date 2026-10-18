import { describe, expect, it, vi } from 'vitest';

import { shipPhase } from './ship.js';

function noCiOctokit() {
  const notFound = () => Object.assign(new Error('Not Found'), { status: 404 });
  return {
    graphql: async () => ({ markPullRequestReadyForReview: { pullRequest: { isDraft: false } } }),
    rest: {
      pulls: {
        list: async () => ({ data: [{ number: 123 }] }),
        get: async () => ({ data: { draft: false, node_id: 'PR_1' } }),
      },
      issues: {
        get: async () => ({ data: { title: 'No CI' } }),
        createComment: async () => ({ data: { id: 1 } }),
      },
      checks: { listForRef: async () => ({ data: { check_runs: [], total_count: 0 } }) },
      repos: {
        getContent: async () => {
          throw notFound();
        },
        get: async () => ({ data: { default_branch: 'main' } }),
        listCommits: async () => ({ data: [{ sha: 'c1' }] }),
        getCombinedStatusForRef: async () => ({ data: { total_count: 0, statuses: [], sha: 'deadbeef' } }),
      },
    },
  };
}

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const matchingRemote = async (command: string) => {
  if (command === 'git rev-parse HEAD') return { stdout: `${SHA}\n` };
  if (command.startsWith('git ls-remote --heads origin')) return { stdout: `${SHA}\trefs/heads/ship-it/123-ci-poll\n` };
  return { stdout: '' };
};

describe('ship no-CI repo (#2488)', () => {
  it('logs no CI configured and marks ready without waiting the grace period when the repo has no workflows and no default-branch checks', async () => {
    const logs: Array<[string, string]> = [];
    vi.useFakeTimers();
    try {
      const start = Date.now();
      const promise = shipPhase({
        issue: 123,
        repo: 'on-par/software-factory',
        worktree: '/repo-factory-123',
        branch: 'ship-it/123-ci-poll',
        octokit: noCiOctokit() as any,
        watchCI: true,
        log: (type, msg) => logs.push([type, msg]),
        run: matchingRemote,
      });
      await vi.runAllTimersAsync();
      const result = await promise;
      const elapsed = Date.now() - start;

      expect(result).toEqual({ ok: true, prNumber: 123, ciOutcome: 'no-checks' });
      expect(logs).toContainEqual([
        'ship',
        'no CI configured on on-par/software-factory (no workflow files on deadbeef and no checks or statuses on recent main commits); skipping CI wait',
      ]);
      expect(elapsed).toBeLessThan(5_000);
    } finally {
      vi.useRealTimers();
    }
  });
});
