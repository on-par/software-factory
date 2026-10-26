import { workKeyFromIssue } from '../work/work-key.js';
import { describe, expect, it } from 'vitest';

import { shipPhase } from './ship.js';

const STUB_HEAD_SHA = 'a'.repeat(40);

function createOctokit() {
  const calls: any[] = [];
  const octokit = {
    graphql: async () => ({ markPullRequestReadyForReview: { pullRequest: { isDraft: false } } }),
    rest: {
      pulls: {
        list: async () => ({ data: [] }),
        create: async (args: any) => {
          calls.push(['pulls.create', args]);
          return { data: { number: 123 } };
        },
        get: async () => ({ data: { draft: true, node_id: 'PR_1' } }),
      },
      issues: {
        get: async () => ({ data: { title: 'Self-heal committed work' } }),
        createComment: async () => ({ data: { id: 1 } }),
      },
      checks: { listForRef: async () => ({ data: { check_runs: [] } }) },
    },
  };
  return { octokit, calls };
}

function remoteHeadStub(command: string): { stdout: string } | undefined {
  if (command === 'git rev-parse HEAD') return { stdout: `${STUB_HEAD_SHA}\n` };
  const match = /^git ls-remote --heads origin '(.+)'$/.exec(command);
  if (match) return { stdout: `${STUB_HEAD_SHA}\trefs/heads/${match[1]}\n` };
  return undefined;
}

describe('shipPhase stack mode (#3348)', () => {
  const stackRun = async (command: string) => {
    const remote = remoteHeadStub(command);
    if (remote) return remote;
    if (command === 'git status --porcelain') return { stdout: '' };
    if (command === 'git rev-list --count origin/main..HEAD') return { stdout: '1\n' };
    if (command === 'git diff --quiet origin/main..HEAD') throw new Error('trees differ');
    if (command === 'git diff --stat origin/main...HEAD') return { stdout: ' ship.ts | 2 ++\n' };
    return { stdout: '' };
  };
  const stack = { index: 2, count: 3, base: 'factory/23-slice-1', basePr: 41, next: { branch: 'factory/23-slice-3' } };
  const ship = (extra: Record<string, unknown>) => {
    const { octokit, calls } = createOctokit();
    const promise = shipPhase({
      issue: workKeyFromIssue(23),
      repo: 'on-par/software-factory',
      worktree: '/repo-factory-23',
      branch: 'factory/23-slice-2',
      octokit: octokit as any,
      watchCI: false,
      log: () => {},
      run: stackRun,
      slice: { index: 2, count: 3 },
      ...extra,
    });
    return { promise, calls };
  };
  const created = (calls: any[]) => calls.find((c) => c[0] === 'pulls.create')[1];

  it('opens a stack slice PR on its stack base (#3348)', async () => {
    const { promise, calls } = ship({ stack });
    await promise;
    expect(created(calls).base).toBe('factory/23-slice-1');
  });

  it('renders the stack-order line in a stack slice PR body (#3348)', async () => {
    const { promise, calls } = ship({ stack });
    await promise;
    expect(created(calls).body).toContain('slice 2/3');
    expect(created(calls).body).toContain('stacked on #41');
  });

  it('still opens on main without a stack', async () => {
    const { promise, calls } = ship({});
    await promise;
    expect(created(calls).base).toBe('main');
    expect(created(calls).body).not.toContain('factory:stack-order');
  });

  it('ignores the stack for inline work', async () => {
    const { promise, calls } = ship({ stack, work: { id: 'brief-1', kind: 'inline', title: 'Inline' } });
    await promise;
    expect(created(calls).base).toBe('main');
    expect(created(calls).body).not.toContain('factory:stack-order');
  });
});
