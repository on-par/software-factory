import { workKeyFromIssue } from '../work/work-key.js';
import { describe, expect, it, vi } from 'vitest';
import { fakeOctokit } from '../harness/fake-octokit.js';

import { shipPhase } from './ship.js';

const CODEQL_RUN = {
  name: 'CodeQL',
  status: 'completed',
  conclusion: 'failure',
  output: { title: 'CodeQL', summary: '1 new alert including 1 high severity' },
};

function octokitFixture(runs: unknown[], alerts: unknown[]) {
  const calls: string[] = [];
  const { octokit } = fakeOctokit({
    graphql: async () => {
      calls.push('graphql');
      return {};
    },
    'pulls.list': async () => ({ data: [{ number: 123 }] }),
    'pulls.get': async () => {
      calls.push('pulls.get');
      return { data: { draft: false, node_id: 'PR_1' } };
    },
    'issues.get': async () => ({ data: { title: 'Fix CodeQL' } }),
    'issues.createComment': async () => ({ data: { id: 1 } }),
    'checks.listForRef': async () => ({ data: { check_runs: runs } }),
    'codeScanning.listAlertsForRepo': async () => ({ data: alerts }),
  });
  return { octokit, calls };
}

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const matchingRemote = async (command: string) => {
  if (command === 'git rev-parse HEAD') return { stdout: `${SHA}\n` };
  if (command.startsWith('git ls-remote --heads origin')) return { stdout: `${SHA}\trefs/heads/ship-it/123-ci-poll\n` };
  return { stdout: '' };
};

describe('shipPhase — CI failure evidence (#2814)', () => {
  it('attaches CodeQL alert evidence for a #2225-shaped CI failure', async () => {
    const alert = {
      rule: { id: 'js/request-forgery' },
      most_recent_instance: {
        location: { path: 'packages/core/src/sandbox/egress-proxy.ts', start_line: 130 },
        message: { text: 'The URL of this request depends on a user-provided value.' },
      },
    };
    const { octokit, calls } = octokitFixture(
      [{ name: 'lint', status: 'completed', conclusion: 'success' }, CODEQL_RUN],
      [alert],
    );

    vi.useFakeTimers();
    try {
      const promise = shipPhase({
        issue: workKeyFromIssue(123),
        repo: 'on-par/software-factory',
        worktree: '/repo-factory-123',
        branch: 'ship-it/123-ci-poll',
        octokit: octokit as any,
        watchCI: true,
        log: () => {},
        run: matchingRemote,
      });
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toMatchObject({ ok: false, prNumber: 123, ciOutcome: 'failure' });
      expect(result.ciFailure?.failingChecks).toEqual([
        { name: 'CodeQL', conclusion: 'failure', summary: '1 new alert including 1 high severity' },
      ]);
      expect(result.ciFailure?.alerts[0].ruleId).toBe('js/request-forgery');
      expect(result.ciFailure?.alerts[0].location.endsWith('egress-proxy.ts:130')).toBe(true);
      expect(calls).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
