import { workKeyFromIssue } from '../work/work-key.js';
import { describe, expect, it, vi } from 'vitest';

import { shipPhase } from './ship.js';

const SHA = 'a'.repeat(40);

function createOctokit(prDraft: boolean, checkRuns: any[] = []) {
  const calls: any[] = [];
  const octokit = {
    graphql: async (query: string, vars: any) => {
      calls.push(['graphql', query, vars]);
      return {};
    },
    rest: {
      pulls: {
        list: async () => ({ data: [] }),
        create: async (args: any) => {
          calls.push(['pulls.create', args]);
          return { data: { number: 123 } };
        },
        get: async () => ({ data: { draft: prDraft, node_id: 'PR_1' } }),
      },
      issues: {
        get: async () => ({ data: { title: 'Self-heal committed work' } }),
        createComment: async () => ({ data: { id: 1 } }),
      },
      checks: { listForRef: async () => ({ data: { check_runs: checkRuns } }) },
      repos: { getCombinedStatusForRef: async () => ({ data: { total_count: 0, statuses: [], sha: SHA } }) },
    },
  };
  return { octokit, calls };
}

const run = async (command: string) => {
  if (command === 'git rev-parse HEAD') return { stdout: `${SHA}\n` };
  if (command.startsWith('git ls-remote --heads origin'))
    return { stdout: `${SHA}\trefs/heads/ship-it/23-self-heal\n` };
  if (command === 'git status --porcelain') return { stdout: '' };
  if (command === 'git diff --stat origin/main...HEAD') return { stdout: ' ship.ts | 12 ++++\n' };
  if (command === 'git rev-list --count origin/main..HEAD') return { stdout: '1\n' };
  if (command === 'git diff --quiet origin/main..HEAD') throw new Error('trees differ');
  return { stdout: '' };
};

function ship(octokit: any, logs: Array<[string, string]>, watchCI = false) {
  return shipPhase({
    issue: workKeyFromIssue(23),
    repo: 'on-par/software-factory',
    worktree: '/repo-factory-23',
    branch: 'ship-it/23-self-heal',
    octokit,
    watchCI,
    draft: true,
    log: (type, msg) => logs.push([type, msg]),
    run,
  });
}

describe('shipPhase draft PR (#3449)', () => {
  it('leaves the PR as a draft after green CI and logs "left as draft"', async () => {
    const { octokit, calls } = createOctokit(true);
    const logs: Array<[string, string]> = [];
    expect(await ship(octokit, logs)).toEqual({ ok: true, prNumber: 123, draft: true });
    expect(calls.map(([name]) => name)).not.toContain('graphql');
    expect(calls.find(([name]) => name === 'pulls.create')?.[1].draft).toBe(true);
    expect(logs).toContainEqual(['ready', 'PR #123 left as draft']);
  });

  it('leaves an already-open non-draft PR as is and says so', async () => {
    const { octokit, calls } = createOctokit(false);
    const logs: Array<[string, string]> = [];
    await ship(octokit, logs);
    expect(calls.map(([name]) => name)).not.toContain('graphql');
    expect(logs.some(([type, msg]) => type === 'ship' && msg.includes('draft mode leaves it as is'))).toBe(true);
  });

  it('says it is leaving the PR as draft when CI times out', async () => {
    const { octokit, calls } = createOctokit(true, [{ status: 'in_progress', conclusion: null }]);
    const logs: Array<[string, string]> = [];
    vi.useFakeTimers();
    try {
      const promise = ship(octokit, logs, true);
      await vi.runAllTimersAsync();
      expect(await promise).toMatchObject({ ok: true, ciOutcome: 'timeout', draft: true, ciPending: true });
    } finally {
      vi.useRealTimers();
    }
    expect(calls.map(([name]) => name)).not.toContain('graphql');
    expect(logs).toContainEqual([
      'ship',
      'CI pending for PR #123: CI did not finish within 10 min; leaving PR as draft',
    ]);
    expect(logs).toContainEqual(['ready', 'PR #123 left as draft (CI pending)']);
  });
});
