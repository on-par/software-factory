import { describe, expect, it, vi } from 'vitest';
import { shipPhase } from './ship.js';

function createOctokit(prDraft = true) {
  const calls: any[] = [];
  const octokit = {
    graphql: async (query: string, vars: any) => {
      calls.push(['graphql', query, vars]);
      return { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } };
    },
    rest: {
      pulls: {
        list: async (args: any) => {
          calls.push(['pulls.list', args]);
          return { data: [] };
        },
        create: async (args: any) => {
          calls.push(['pulls.create', args]);
          return { data: { number: 123 } };
        },
        get: async (args: any) => {
          calls.push(['pulls.get', args]);
          return { data: { draft: prDraft, node_id: 'PR_1' } };
        },
      },
      issues: {
        get: async (args: any) => {
          calls.push(['issues.get', args]);
          return { data: { title: 'Self-heal committed work' } };
        },
      },
      checks: {
        listForRef: async (args: any) => {
          calls.push(['checks.listForRef', args]);
          return { data: { check_runs: [] } };
        },
      },
    },
  };

  return { octokit, calls };
}

function scriptChecks(sequence: any[][]) {
  let i = 0;
  const listForRef = async (_args: any) => {
    const runs = sequence[Math.min(i, sequence.length - 1)];
    i++;
    return { data: { check_runs: runs } };
  };
  return { listForRef, callCount: () => i };
}

const pending = [{ status: 'in_progress', conclusion: null }];
const allSuccess = [{ status: 'completed', conclusion: 'success' }];
const oneFailure = [
  { status: 'completed', conclusion: 'success' },
  { status: 'completed', conclusion: 'failure' },
];

function createWatchOctokit(sequence: any[][]) {
  const calls: any[] = [];
  const { listForRef, callCount } = scriptChecks(sequence);
  const octokit = {
    graphql: async (query: string, vars: any) => {
      calls.push(['graphql', query, vars]);
      return { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } };
    },
    rest: {
      pulls: {
        list: async (args: any) => {
          calls.push(['pulls.list', args]);
          return { data: [{ number: 123 }] };
        },
        create: async (args: any) => {
          calls.push(['pulls.create', args]);
          return { data: { number: 123 } };
        },
        get: async (args: any) => {
          calls.push(['pulls.get', args]);
          return { data: { draft: false, node_id: 'PR_1' } };
        },
      },
      issues: {
        get: async (args: any) => {
          calls.push(['issues.get', args]);
          return { data: { title: 'Self-heal committed work' } };
        },
      },
      checks: {
        listForRef: async (args: any) => {
          calls.push(['checks.listForRef', args]);
          return listForRef(args);
        },
      },
    },
  };

  return { octokit, calls, callCount };
}

describe('shipPhase self-healing', () => {
  it('pushes and opens a house-format PR when committed work is clean and ahead', async () => {
    const { octokit, calls } = createOctokit();
    const commands: string[] = [];
    const logs: Array<[string, string]> = [];
    const run = async (command: string) => {
      commands.push(command);
      if (command === 'git status --porcelain') return { stdout: '' };
      if (command === 'git rev-list --count origin/main..HEAD') return { stdout: '1\n' };
      if (command === 'git diff --stat origin/main...HEAD') return { stdout: ' ship.ts | 12 ++++++++++++\n' };
      return { stdout: '' };
    };

    const result = await shipPhase({
      issue: 23,
      repo: 'on-par/software-factory',
      worktree: '/repo-factory-23',
      branch: 'ship-it/23-self-heal',
      octokit: octokit as any,
      watchCI: false,
      log: (type, msg) => logs.push([type, msg]),
      run,
    });

    expect(result).toEqual({ ok: true, prNumber: 123 });
    expect(commands).toEqual([
      'git status --porcelain',
      'git rev-list --count origin/main..HEAD',
      "git push -u origin 'ship-it/23-self-heal'",
      'git diff --stat origin/main...HEAD',
    ]);
    expect(calls).toContainEqual([
      'pulls.create',
      expect.objectContaining({
        owner: 'on-par',
        repo: 'software-factory',
        head: 'ship-it/23-self-heal',
        base: 'main',
        title: 'Self-heal committed work (#23)',
        body: expect.stringContaining('Closes #23'),
      }),
    ]);
    expect(calls).toContainEqual([
      'pulls.get',
      { owner: 'on-par', repo: 'software-factory', pull_number: 123 },
    ]);
    expect(calls).toContainEqual([
      'graphql',
      expect.stringContaining('markPullRequestReadyForReview'),
      { id: 'PR_1' },
    ]);
    expect(logs).toContainEqual(['recovered', 'opened PR #123 for committed work on ship-it/23-self-heal']);
  });

  it('does not mark a pull request ready when it is not a draft', async () => {
    const { octokit, calls } = createOctokit(false);
    const logs: Array<[string, string]> = [];
    const run = async (command: string) => {
      if (command === 'git status --porcelain') return { stdout: '' };
      if (command === 'git rev-list --count origin/main..HEAD') return { stdout: '1\n' };
      if (command === 'git diff --stat origin/main...HEAD') return { stdout: ' ship.ts | 12 ++++++++++++\n' };
      return { stdout: '' };
    };

    const result = await shipPhase({
      issue: 23,
      repo: 'on-par/software-factory',
      worktree: '/repo-factory-23',
      branch: 'ship-it/23-self-heal',
      octokit: octokit as any,
      watchCI: false,
      log: (type, msg) => logs.push([type, msg]),
      run,
    });

    expect(result).toEqual({ ok: true, prNumber: 123 });
    expect(calls).toContainEqual([
      'pulls.get',
      { owner: 'on-par', repo: 'software-factory', pull_number: 123 },
    ]);
    expect(calls.some(call => call[0] === 'graphql')).toBe(false);
  });

  it('does not push or open a PR when the worktree has uncommitted changes', async () => {
    const { octokit, calls } = createOctokit();
    const commands: string[] = [];
    const logs: Array<[string, string]> = [];
    const run = async (command: string) => {
      commands.push(command);
      if (command === 'git status --porcelain') return { stdout: ' M packages/core/src/phases/ship.ts\n' };
      if (command === 'git rev-list --count origin/main..HEAD') return { stdout: '1\n' };
      return { stdout: '' };
    };

    const result = await shipPhase({
      issue: 23,
      repo: 'on-par/software-factory',
      worktree: '/repo-factory-23',
      branch: 'ship-it/23-self-heal',
      octokit: octokit as any,
      watchCI: false,
      log: (type, msg) => logs.push([type, msg]),
      run,
    });

    expect(result).toEqual({ ok: false });
    expect(commands).toEqual([
      'git status --porcelain',
      'git rev-list --count origin/main..HEAD',
    ]);
    expect(calls).not.toContainEqual(['pulls.create', expect.anything()]);
    expect(logs).toContainEqual(['ship', 'not recovering ship-it/23-self-heal: worktree has uncommitted changes']);
  });

  it('reports fail and returns not ok when a PR cannot be created or found', async () => {
    const { octokit, calls } = createOctokit();
    octokit.rest.pulls.create = async (args: any) => {
      calls.push(['pulls.create', args]);
      return { data: { number: 0 } };
    };
    const logs: Array<[string, string]> = [];
    const run = async (command: string) => {
      if (command === 'git status --porcelain') return { stdout: '' };
      if (command === 'git rev-list --count origin/main..HEAD') return { stdout: '1\n' };
      if (command === 'git diff --stat origin/main...HEAD') return { stdout: ' ship.ts | 12 ++++++++++++\n' };
      return { stdout: '' };
    };

    const result = await shipPhase({
      issue: 23,
      repo: 'on-par/software-factory',
      worktree: '/repo-factory-23',
      branch: 'ship-it/23-self-heal',
      octokit: octokit as any,
      watchCI: false,
      log: (type, msg) => logs.push([type, msg]),
      run,
    });

    expect(result).toEqual({ ok: false });
    expect(logs).toContainEqual(['fail', 'Could not create or find PR for ship-it/23-self-heal']);
  });
});

describe('shipPhase CI watch', () => {
  it('logs CI green and stops polling once all checks complete successfully', async () => {
    const { octokit, callCount } = createWatchOctokit([pending, pending, allSuccess]);
    const logs: Array<[string, string]> = [];
    const run = async () => ({ stdout: '' });

    vi.useFakeTimers();
    try {
      const promise = shipPhase({
        issue: 123,
        repo: 'on-par/software-factory',
        worktree: '/repo-factory-123',
        branch: 'ship-it/123-ci-poll',
        octokit: octokit as any,
        watchCI: true,
        log: (type, msg) => logs.push([type, msg]),
        run,
      });
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toEqual({ ok: true, prNumber: 123 });
      expect(logs).toContainEqual(['ship', 'CI green for PR #123']);
      expect(logs.some(([, msg]) => msg.includes('CI failed'))).toBe(false);
      expect(logs).toContainEqual(['ready', 'PR #123 ready for review']);
      expect(callCount()).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs CI failed and stops polling once a check run fails', async () => {
    const { octokit, callCount } = createWatchOctokit([pending, oneFailure]);
    const logs: Array<[string, string]> = [];
    const run = async () => ({ stdout: '' });

    vi.useFakeTimers();
    try {
      const promise = shipPhase({
        issue: 123,
        repo: 'on-par/software-factory',
        worktree: '/repo-factory-123',
        branch: 'ship-it/123-ci-poll',
        octokit: octokit as any,
        watchCI: true,
        log: (type, msg) => logs.push([type, msg]),
        run,
      });
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toEqual({ ok: true, prNumber: 123 });
      expect(logs).toContainEqual(['ship', 'CI failed for PR #123']);
      expect(logs.some(([, msg]) => msg.includes('CI green'))).toBe(false);
      expect(callCount()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up after the 10-minute deadline when checks never complete', async () => {
    const { octokit, callCount } = createWatchOctokit([pending]);
    const logs: Array<[string, string]> = [];
    const run = async () => ({ stdout: '' });

    vi.useFakeTimers();
    try {
      const promise = shipPhase({
        issue: 123,
        repo: 'on-par/software-factory',
        worktree: '/repo-factory-123',
        branch: 'ship-it/123-ci-poll',
        octokit: octokit as any,
        watchCI: true,
        log: (type, msg) => logs.push([type, msg]),
        run,
      });
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toEqual({ ok: true, prNumber: 123 });
      expect(logs.some(([, msg]) => msg.includes('CI green'))).toBe(false);
      expect(logs.some(([, msg]) => msg.includes('CI failed'))).toBe(false);
      expect(logs).toContainEqual(['ready', 'PR #123 ready for review']);
      expect(callCount()).toBeGreaterThan(0);
      expect(callCount()).toBeLessThanOrEqual(15); // backoff → far fewer polls than fixed 15s (~40)
    } finally {
      vi.useRealTimers();
    }
  });
});
