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
    expect(calls).toContainEqual(['pulls.get', { owner: 'on-par', repo: 'software-factory', pull_number: 123 }]);
    expect(calls).toContainEqual(['graphql', expect.stringContaining('markPullRequestReadyForReview'), { id: 'PR_1' }]);
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
    expect(calls).toContainEqual(['pulls.get', { owner: 'on-par', repo: 'software-factory', pull_number: 123 }]);
    expect(calls.some((call) => call[0] === 'graphql')).toBe(false);
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
    expect(commands).toEqual(['git status --porcelain', 'git rev-list --count origin/main..HEAD']);
    expect(calls).not.toContainEqual(['pulls.create', expect.anything()]);
    expect(logs).toContainEqual(['ship', 'not recovering ship-it/23-self-heal: worktree has uncommitted changes']);
  });

  it('does not push or open a PR when there are no commits ahead of origin/main', async () => {
    const { octokit, calls } = createOctokit();
    const commands: string[] = [];
    const logs: Array<[string, string]> = [];
    const run = async (command: string) => {
      commands.push(command);
      if (command === 'git status --porcelain') return { stdout: '' };
      if (command === 'git rev-list --count origin/main..HEAD') return { stdout: '0\n' };
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
    expect(commands).toEqual(['git status --porcelain', 'git rev-list --count origin/main..HEAD']);
    expect(calls).not.toContainEqual(['pulls.create', expect.anything()]);
    expect(logs).toContainEqual(['ship', 'not recovering ship-it/23-self-heal: no commits ahead of origin/main']);
  });

  it('logs and continues when git push fails instead of aborting the recovery', async () => {
    const { octokit, calls } = createOctokit();
    const logs: Array<[string, string]> = [];
    const run = async (command: string) => {
      if (command === 'git status --porcelain') return { stdout: '' };
      if (command === 'git rev-list --count origin/main..HEAD') return { stdout: '1\n' };
      if (command.startsWith('git push')) throw new Error('remote rejected');
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
    expect(logs).toContainEqual(['ship', 'push failed — trying to continue']);
    expect(calls).toContainEqual(['pulls.create', expect.anything()]);
  });

  it('falls through to pulls.create when findOpenPR throws', async () => {
    const { octokit, calls } = createOctokit();
    octokit.rest.pulls.list = async (args: any) => {
      calls.push(['pulls.list', args]);
      throw new Error('list failed');
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

    expect(result).toEqual({ ok: true, prNumber: 123 });
    expect(calls).toContainEqual(['pulls.create', expect.anything()]);
  });

  it('builds the PR body with an empty diff stat when computeDiffStat throws', async () => {
    const { octokit, calls } = createOctokit();
    const logs: Array<[string, string]> = [];
    const run = async (command: string) => {
      if (command === 'git status --porcelain') return { stdout: '' };
      if (command === 'git rev-list --count origin/main..HEAD') return { stdout: '1\n' };
      if (command === 'git diff --stat origin/main...HEAD') throw new Error('diff failed');
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
      'pulls.create',
      expect.objectContaining({ body: expect.stringContaining('```\n\n```') }),
    ]);
  });

  it('still completes and logs ready when marking the PR ready for review throws', async () => {
    const { octokit, calls } = createOctokit();
    octokit.rest.pulls.get = async (args: any) => {
      calls.push(['pulls.get', args]);
      throw new Error('pulls.get failed');
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

    expect(result).toEqual({ ok: true, prNumber: 123 });
    expect(logs).toContainEqual(['ready', 'PR #123 ready for review']);
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

  it('still logs ready when watching CI throws', async () => {
    const { octokit } = createWatchOctokit([allSuccess]);
    octokit.rest.checks.listForRef = async () => {
      throw new Error('checks API unavailable');
    };
    const logs: Array<[string, string]> = [];
    const run = async () => ({ stdout: '' });

    const result = await shipPhase({
      issue: 123,
      repo: 'on-par/software-factory',
      worktree: '/repo-factory-123',
      branch: 'ship-it/123-ci-poll',
      octokit: octokit as any,
      watchCI: true,
      log: (type, msg) => logs.push([type, msg]),
      run,
    });

    expect(result).toEqual({ ok: true, prNumber: 123 });
    expect(logs).toContainEqual(['ready', 'PR #123 ready for review']);
  });
});

describe('shipPhase approval gate', () => {
  it('approves: gate resolving approved:true lets ship proceed and logs ship, then approval_requested, then approval_granted', async () => {
    const { octokit, calls } = createOctokit();
    const logs: Array<[string, string]> = [];
    const diffStatCalls: string[] = [];
    const run = async (command: string) => {
      if (command === 'git status --porcelain') return { stdout: '' };
      if (command === 'git rev-list --count origin/main..HEAD') return { stdout: '1\n' };
      if (command === 'git diff --stat origin/main...HEAD') {
        diffStatCalls.push(command);
        return { stdout: ' ship.ts | 12 ++++++++++++\n' };
      }
      return { stdout: '' };
    };
    const checkSummary = { failures: 0, passes: 3, skips: 0, total: 3, results: [] };
    const approvalGate = vi.fn(async () => ({ id: 'a1', approved: true, respondedAt: new Date().toISOString() }));

    const result = await shipPhase({
      issue: 23,
      repo: 'on-par/software-factory',
      worktree: '/repo-factory-23',
      branch: 'ship-it/23-self-heal',
      octokit: octokit as any,
      watchCI: false,
      log: (type, msg) => logs.push([type, msg]),
      run,
      approvalGate,
      checkSummary,
    });

    expect(result.ok).toBe(true);
    expect(calls.filter((c) => c[0] === 'pulls.create')).toHaveLength(1);
    expect(approvalGate).toHaveBeenCalledWith(
      expect.objectContaining({
        issue: 23,
        branch: 'ship-it/23-self-heal',
        worktree: '/repo-factory-23',
        checkSummary,
      }),
    );
    // git diff --stat runs exactly once — the PR body reuses the approval gate's diffStat.
    expect(diffStatCalls).toHaveLength(1);
    const shipIdx = logs.findIndex(([type]) => type === 'ship');
    const requestedIdx = logs.findIndex(([type]) => type === 'approval_requested');
    const grantedIdx = logs.findIndex(([type]) => type === 'approval_granted');
    expect(shipIdx).toBe(0);
    expect(requestedIdx).toBeGreaterThan(shipIdx);
    expect(grantedIdx).toBeGreaterThan(requestedIdx);
    expect(logs[requestedIdx][1]).toContain('checks: 3 pass, 0 fail, 0 skip');
    expect(calls).toContainEqual([
      'pulls.create',
      expect.objectContaining({ body: expect.stringContaining('ship.ts | 12 ++++++++++++') }),
    ]);
  });

  it('denies: gate resolving approved:false stops before push/PR and logs ship_denied with the reason', async () => {
    const { octokit, calls } = createOctokit();
    const logs: Array<[string, string]> = [];
    const commands: string[] = [];
    const run = async (command: string) => {
      commands.push(command);
      if (command === 'git diff --stat origin/main...HEAD') return { stdout: ' ship.ts | 12 ++++++++++++\n' };
      return { stdout: '' };
    };
    const approvalGate = vi.fn(async () => ({
      id: 'a2',
      approved: false,
      reason: 'not today',
      respondedAt: new Date().toISOString(),
    }));

    const result = await shipPhase({
      issue: 23,
      repo: 'on-par/software-factory',
      worktree: '/repo-factory-23',
      branch: 'ship-it/23-self-heal',
      octokit: octokit as any,
      watchCI: false,
      log: (type, msg) => logs.push([type, msg]),
      run,
      approvalGate,
    });

    expect(result).toEqual({ ok: false, denied: true, deniedReason: 'not today' });
    expect(calls).toEqual([]);
    expect(commands).toEqual(['git diff --stat origin/main...HEAD']);
    expect(logs).toContainEqual(['ship_denied', 'ship denied for ship-it/23-self-heal: not today']);
    // A 'ship'-typed event fires first so a denial doesn't misreport the TUI's failed phase as CHECK/BUILD.
    expect(logs[0]).toEqual(['ship', 'Starting ship phase for ship-it/23-self-heal']);
  });

  it('denies with the default "denied" reason when the gate response omits one', async () => {
    const { octokit, calls } = createOctokit();
    const logs: Array<[string, string]> = [];
    const run = async (command: string) => {
      if (command === 'git diff --stat origin/main...HEAD') return { stdout: ' ship.ts | 12 ++++++++++++\n' };
      return { stdout: '' };
    };
    const approvalGate = vi.fn(async () => ({ id: 'a3', approved: false, respondedAt: new Date().toISOString() }));

    const result = await shipPhase({
      issue: 23,
      repo: 'on-par/software-factory',
      worktree: '/repo-factory-23',
      branch: 'ship-it/23-self-heal',
      octokit: octokit as any,
      watchCI: false,
      log: (type, msg) => logs.push([type, msg]),
      run,
      approvalGate,
    });

    expect(result).toEqual({ ok: false, denied: true, deniedReason: 'denied' });
    expect(calls).toEqual([]);
    expect(logs).toContainEqual(['ship_denied', 'ship denied for ship-it/23-self-heal: denied']);
  });

  it('no gate: behaves exactly like the non-interactive path (no approval_requested/granted logs)', async () => {
    const { octokit } = createOctokit();
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
    expect(logs.some(([type]) => type === 'approval_requested' || type === 'approval_granted')).toBe(false);
  });
});
