import { describe, expect, it, vi } from 'vitest';

import { shipPhase } from './ship.js';

const SHA = 'a'.repeat(40);

function createOctokit(checkRuns: any[]) {
  const graphqlCalls: string[] = [];
  const octokit = {
    graphql: async (query: string) => {
      graphqlCalls.push(query);
      return {};
    },
    rest: {
      pulls: {
        list: async () => ({ data: [] }),
        create: async () => ({ data: { number: 123 } }),
        get: async () => ({ data: { draft: true, node_id: 'PR_1' } }),
      },
      issues: {
        get: async () => ({ data: { title: 'Slow CI' } }),
        createComment: async () => ({ data: { id: 1 } }),
      },
      checks: { listForRef: async () => ({ data: { check_runs: checkRuns } }) },
      repos: { getCombinedStatusForRef: async () => ({ data: { total_count: 0, statuses: [], sha: SHA } }) },
    },
  };
  return { octokit, graphqlCalls };
}

const run = async (command: string) => {
  if (command === 'git rev-parse HEAD') return { stdout: `${SHA}\n` };
  if (command.startsWith('git ls-remote --heads origin')) return { stdout: `${SHA}\trefs/heads/ship-it/7-slow-ci\n` };
  if (command === 'git status --porcelain') return { stdout: '' };
  if (command === 'git diff --stat origin/main...HEAD') return { stdout: ' ship.ts | 12 ++++\n' };
  if (command === 'git rev-list --count origin/main..HEAD') return { stdout: '1\n' };
  if (command === 'git diff --quiet origin/main..HEAD') throw new Error('trees differ');
  return { stdout: '' };
};

async function ship(checkRuns: any[], extra: { ciDeadlineMs?: number } = {}) {
  const { octokit, graphqlCalls } = createOctokit(checkRuns);
  const logs: Array<[string, string]> = [];
  vi.useFakeTimers();
  try {
    const start = Date.now();
    const promise = shipPhase({
      issue: 7,
      repo: 'on-par/software-factory',
      worktree: '/repo-factory-7',
      branch: 'ship-it/7-slow-ci',
      octokit: octokit as any,
      watchCI: true,
      log: (type, msg) => logs.push([type, msg]),
      run,
      ...extra,
    });
    await vi.runAllTimersAsync();
    const result = await promise;
    return { result, logs, graphqlCalls, elapsed: Date.now() - start };
  } finally {
    vi.useRealTimers();
  }
}

const pending = [{ name: 'build', status: 'in_progress', conclusion: null }];
const green = [{ name: 'build', status: 'completed', conclusion: 'success' }];

describe('shipPhase CI pending (#3569)', () => {
  it('a CI watch timeout leaves the PR draft and reports CI pending', async () => {
    const { result, logs, graphqlCalls } = await ship(pending);
    expect(graphqlCalls).toEqual([]);
    expect(logs.some(([type, msg]) => type === 'ship' && msg.includes('CI pending'))).toBe(true);
    expect(result).toMatchObject({ ok: true, ciOutcome: 'timeout', draft: true, ciPending: true });
  });

  it('ship passes the ciDeadlineMs option to the CI watch and defaults to 10 minutes', async () => {
    const short = await ship(pending, { ciDeadlineMs: 120_000 });
    expect(short.logs.some(([, msg]) => msg.includes('within 2 min'))).toBe(true);
    expect(short.elapsed).toBeLessThan(5 * 60_000);

    const dflt = await ship(pending);
    expect(dflt.logs.some(([, msg]) => msg.includes('within 10 min'))).toBe(true);
    expect(dflt.elapsed).toBeGreaterThanOrEqual(10 * 60_000);
  });

  it('a green CI watch still marks the draft PR ready', async () => {
    const { result, logs, graphqlCalls } = await ship(green);
    expect(graphqlCalls).toHaveLength(1);
    expect(result).not.toHaveProperty('ciPending');
    expect(result).not.toHaveProperty('draft');
    expect(logs).toContainEqual(['ready', 'PR #123 ready for review']);
  });
});
