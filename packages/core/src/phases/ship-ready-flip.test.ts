import { describe, expect, it } from 'vitest';

import { shipPhase } from './ship.js';

const SHA = 'a'.repeat(40);

function createOctokit(prDraft: boolean, graphqlFailures: number) {
  let failures = graphqlFailures;
  const calls: string[] = [];
  const octokit = {
    graphql: async () => {
      calls.push('graphql');
      if (failures-- > 0) throw new Error('graphql down');
      return {};
    },
    rest: {
      pulls: {
        list: async () => ({ data: [] }),
        create: async () => ({ data: { number: 123 } }),
        get: async () => ({ data: { draft: prDraft, node_id: 'PR_1' } }),
      },
      issues: {
        get: async () => ({ data: { title: 'Self-heal committed work' } }),
        createComment: async () => ({ data: { id: 1 } }),
      },
      checks: { listForRef: async () => ({ data: { check_runs: [] } }) },
      repos: { getCombinedStatusForRef: async () => ({ data: { total_count: 0, statuses: [], sha: SHA } }) },
    },
  };
  return { octokit, calls };
}

const run = async (command: string) => {
  if (command === 'git rev-parse HEAD') return { stdout: `${SHA}\n` };
  if (command.startsWith('git ls-remote --heads origin'))
    return { stdout: `${SHA}\trefs/heads/ship-it/23-self-heal\n` };
  if (command === 'git diff --stat origin/main...HEAD') return { stdout: ' ship.ts | 12 ++++\n' };
  if (command === 'git rev-list --count origin/main..HEAD') return { stdout: '1\n' };
  if (command === 'git diff --quiet origin/main..HEAD') throw new Error('trees differ');
  return { stdout: '' };
};

function ship(octokit: any, logs: Array<[string, string]>) {
  return shipPhase({
    issue: 23,
    repo: 'on-par/software-factory',
    worktree: '/repo-factory-23',
    branch: 'ship-it/23-self-heal',
    octokit,
    watchCI: false,
    draft: false,
    log: (type, msg) => logs.push([type, msg]),
    run,
  });
}

describe('shipPhase ready flip (#3551)', () => {
  it('draft mode off — a successful SHIP leaves the PR not a draft', async () => {
    const { octokit, calls } = createOctokit(true, 0);
    const logs: Array<[string, string]> = [];
    expect(await ship(octokit, logs)).toMatchObject({ ok: true, prNumber: 123 });
    expect(calls).toEqual(['graphql']);
  });

  it('retries a failed ready flip once and succeeds', async () => {
    const { octokit, calls } = createOctokit(true, 1);
    const logs: Array<[string, string]> = [];
    expect(await ship(octokit, logs)).toMatchObject({ ok: true });
    expect(calls).toEqual(['graphql', 'graphql']);
    expect(logs).toContainEqual(['ready', 'PR #123 ready for review']);
  });

  it('a ready flip that fails twice logs a warn naming the PR and no ready event', async () => {
    const { octokit } = createOctokit(true, 2);
    const logs: Array<[string, string]> = [];
    const result = await ship(octokit, logs);
    expect(result).toMatchObject({ ok: false, prNumber: 123 });
    expect(logs.filter(([type, msg]) => type === 'warn' && msg.includes('PR #123'))).toHaveLength(1);
    expect(logs.some(([type]) => type === 'ready')).toBe(false);
  });
});
