import { workKeyFromIssue } from '../work/work-key.js';
import { describe, expect, it, vi } from 'vitest';

import { shipPhase } from './ship.js';

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const remote = async (command: string) => {
  if (command === 'git rev-parse HEAD') return { stdout: `${SHA}\n` };
  if (command.startsWith('git ls-remote --heads origin')) return { stdout: `${SHA}\trefs/heads/ship-it/123-ci-poll\n` };
  return { stdout: '' };
};

function octokitWith(sequence: any[][]) {
  let polls = 0;
  const notFound = () => Object.assign(new Error('Not Found'), { status: 404 });
  return {
    graphql: async () => ({ markPullRequestReadyForReview: { pullRequest: { isDraft: false } } }),
    rest: {
      pulls: {
        list: async () => ({ data: [{ number: 123 }] }),
        get: async () => ({ data: { draft: false, node_id: 'PR_1' } }),
      },
      issues: {
        get: async () => ({ data: { title: 'Late CI' } }),
        createComment: async () => ({ data: { id: 1 } }),
      },
      checks: {
        listForRef: async () => ({ data: { check_runs: sequence[Math.min(polls++, sequence.length - 1)] } }),
      },
      repos: {
        getStatusChecksProtection: async () => ({ data: { contexts: ['verify'] } }),
        getBranchRules: async () => {
          throw notFound();
        },
        getContent: async () => ({ data: [{ type: 'file' }] }),
        getCombinedStatusForRef: async () => ({ data: { total_count: 0, statuses: [], sha: 'deadbeef' } }),
      },
    },
  };
}

async function runShip(sequence: any[][]) {
  const logs: Array<[string, string]> = [];
  vi.useFakeTimers();
  try {
    const promise = shipPhase({
      issue: workKeyFromIssue(123),
      repo: 'on-par/software-factory',
      worktree: '/repo-factory-123',
      branch: 'ship-it/123-ci-poll',
      octokit: octokitWith(sequence) as any,
      watchCI: true,
      log: (type, msg) => logs.push([type, msg]),
      run: remote,
    });
    await vi.runAllTimersAsync();
    return { result: await promise, logs };
  } finally {
    vi.useRealTimers();
  }
}

describe('ship waits for required checks (#3206)', () => {
  it('a PR with no checks yet waits for CI instead of skipping it', async () => {
    const verify = [{ name: 'verify', status: 'completed', conclusion: 'success' }];
    const { result, logs } = await runShip([[], [], [], [], verify]);

    expect(result).toEqual({ ok: true, prNumber: 123, ciOutcome: 'success' });
    expect(logs.some(([, msg]) => msg.includes('skipping CI wait'))).toBe(false);
  });

  it('logs the required check that has not reported yet', async () => {
    const { logs } = await runShip([[]]);

    expect(logs).toContainEqual([
      'ship',
      expect.stringMatching(/^CI for PR #123: waiting for required check verify \(not reported yet\), \d+ min left$/),
    ]);
  });
});
