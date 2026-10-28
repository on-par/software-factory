// packages/core/src/phases/ship.base-branch.test.ts — the PR opens against baseBranch when set (#3764)
import { describe, expect, it } from 'vitest';

import { workKeyFromIssue } from '../work/work-key.js';
import { shipPhase } from './ship.js';

const HEAD_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

async function openPrBase(baseBranch?: string): Promise<string> {
  const created: Array<{ base: string }> = [];
  const octokit = {
    graphql: async () => ({ markPullRequestReadyForReview: { pullRequest: { isDraft: false } } }),
    rest: {
      pulls: {
        list: async () => ({ data: [] }),
        create: async (args: { base: string }) => {
          created.push(args);
          return { data: { number: 123 } };
        },
        get: async () => ({ data: { draft: true, node_id: 'PR_1' } }),
      },
      issues: {
        get: async () => ({ data: { title: 'Start from a branch' } }),
        createComment: async () => ({ data: { id: 1 } }),
      },
      checks: { listForRef: async () => ({ data: { check_runs: [] } }) },
    },
  };
  const run = async (command: string) => {
    if (command === 'git rev-parse HEAD') return { stdout: `${HEAD_SHA}\n` };
    const match = /^git ls-remote --heads origin '(.+)'$/.exec(command);
    if (match) return { stdout: `${HEAD_SHA}\trefs/heads/${match[1]}\n` };
    if (command === 'git rev-list --count origin/main..HEAD') return { stdout: '1\n' };
    if (command === 'git diff --quiet origin/main..HEAD') throw new Error('trees differ');
    if (command === 'git diff --stat origin/main...HEAD') return { stdout: ' a.ts | 1 +\n' };
    return { stdout: '' };
  };
  await shipPhase({
    issue: workKeyFromIssue(23),
    repo: 'on-par/software-factory',
    worktree: '/repo-factory-23',
    branch: 'ship-it/23-base',
    octokit: octokit as never,
    watchCI: false,
    log: () => {},
    run,
    ...(baseBranch === undefined ? {} : { baseBranch }),
  });
  return created[0].base;
}

describe('shipPhase baseBranch (#3764)', () => {
  it('opens the PR against baseBranch when set', async () => {
    expect(await openPrBase('feat/x')).toBe('feat/x');
  });

  it('opens the PR against main when baseBranch is omitted', async () => {
    expect(await openPrBase()).toBe('main');
  });
});
