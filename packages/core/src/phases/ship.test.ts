import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LaneLifecycleEventSchema } from '@on-par/contracts';
import { describe, expect, it, vi } from 'vitest';

import { createLifecycleBus } from '../bus/index.js';
import { findMergedPR, findOpenPR, shipPhase } from './ship.js';

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
        createComment: async (args: any) => {
          calls.push(['issues.createComment', args]);
          return { data: { id: 1 } };
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
        createComment: async (args: any) => {
          calls.push(['issues.createComment', args]);
          return { data: { id: 1 } };
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

const STUB_HEAD_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

/** stdout for the two remote-head verification commands the recovery path runs before opening a
 *  PR (#735); returns undefined for any other command so callers keep their own handling. The
 *  branch is pulled out of the `git ls-remote --heads origin '<branch>'` command text itself, so
 *  callers don't need to pass it in. */
function remoteHeadStub(command: string, remoteSha = STUB_HEAD_SHA): { stdout: string } | undefined {
  if (command === 'git rev-parse HEAD') return { stdout: `${STUB_HEAD_SHA}\n` };
  const match = /^git ls-remote --heads origin '(.+)'$/.exec(command);
  if (match) return { stdout: `${remoteSha}\trefs/heads/${match[1]}\n` };
  return undefined;
}

describe('shipPhase self-healing', () => {
  it('pushes and opens a house-format PR when committed work is clean and ahead', async () => {
    const { octokit, calls } = createOctokit();
    const commands: string[] = [];
    const logs: Array<[string, string]> = [];
    const run = async (command: string) => {
      commands.push(command);
      const remote = remoteHeadStub(command);
      if (remote) return remote;
      if (command === 'git status --porcelain') return { stdout: '' };
      if (command === 'git rev-list --count origin/main..HEAD') return { stdout: '1\n' };
      if (command === 'git diff --quiet origin/main..HEAD') throw new Error('trees differ');
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
      'git fetch origin main',
      'git status --porcelain',
      'git rev-list --count origin/main..HEAD',
      'git diff --quiet origin/main..HEAD',
      "git push -u origin 'ship-it/23-self-heal'",
      'git rev-parse HEAD',
      "git ls-remote --heads origin 'ship-it/23-self-heal'",
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
      const remote = remoteHeadStub(command);
      if (remote) return remote;
      if (command === 'git status --porcelain') return { stdout: '' };
      if (command === 'git rev-list --count origin/main..HEAD') return { stdout: '1\n' };
      if (command === 'git diff --quiet origin/main..HEAD') throw new Error('trees differ');
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

  it('commits leftover build output after a green check and proceeds to the PR', async () => {
    const { octokit, calls } = createOctokit();
    const commands: string[] = [];
    const logs: Array<[string, string]> = [];
    let committed = false;
    const run = async (command: string) => {
      commands.push(command);
      if (command.startsWith('git commit')) committed = true;
      const remote = remoteHeadStub(command);
      if (remote) return remote;
      if (command === 'git status --porcelain') {
        return {
          stdout: committed ? '' : ' M packages/core/src/phases/ship.ts\n?? packages/core/src/phases/new.test.ts\n',
        };
      }
      if (command === 'git rev-list --count origin/main..HEAD') return { stdout: '1\n' };
      if (command === 'git diff --quiet origin/main..HEAD') throw new Error('trees differ');
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
    expect(commands).toContain('git add -A');
    const commit = commands.find((c) => c.startsWith('git commit -m'));
    expect(commit).toContain('chore(ship): commit build output left after check (#23)');
    expect(calls).toContainEqual(['pulls.create', expect.anything()]);
    expect(logs).toContainEqual(['ship', 'committed 2 uncommitted path(s) left after check on ship-it/23-self-heal']);
    expect(logs).not.toContainEqual(['ship', expect.stringContaining('worktree has uncommitted changes')]);
  });

  it('parks with a conflict-naming reason and touches nothing when the worktree has unmerged entries', async () => {
    const { octokit, calls } = createOctokit();
    const commands: string[] = [];
    const logs: Array<[string, string]> = [];
    const run = async (command: string) => {
      commands.push(command);
      if (command === 'git status --porcelain') {
        return { stdout: 'UU packages/core/src/phases/ship.ts\nM  packages/core/src/other.ts\n' };
      }
      if (command === 'git rev-list --count origin/main..HEAD') return { stdout: '1\n' };
      if (command === 'git diff --quiet origin/main..HEAD') throw new Error('trees differ');
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

    expect(result).toEqual({ ok: false, reason: 'worktree has merge conflicts in packages/core/src/phases/ship.ts' });
    expect(
      commands.some((c) => c.startsWith('git add') || c.startsWith('git commit') || c.startsWith('git push')),
    ).toBe(false);
    expect(calls).not.toContainEqual(['pulls.create', expect.anything()]);
    expect(logs).toContainEqual([
      'ship',
      'not recovering ship-it/23-self-heal: worktree has merge conflicts in packages/core/src/phases/ship.ts — worktree preserved',
    ]);
  });

  it("parks with git's own error when the auto-commit fails", async () => {
    const { octokit, calls } = createOctokit();
    const commands: string[] = [];
    const logs: Array<[string, string]> = [];
    const run = async (command: string) => {
      commands.push(command);
      if (command.startsWith('git commit')) {
        throw Object.assign(new Error('commit failed'), { stderr: 'fatal: cannot commit\n' });
      }
      if (command === 'git status --porcelain') return { stdout: '?? scratch.txt\n' };
      if (command === 'git rev-list --count origin/main..HEAD') return { stdout: '1\n' };
      if (command === 'git diff --quiet origin/main..HEAD') throw new Error('trees differ');
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

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/^could not commit leftover build output:/);
    expect(result.reason).toContain('fatal: cannot commit');
    expect(commands.some((c) => c.startsWith('git push'))).toBe(false);
    expect(calls).not.toContainEqual(['pulls.create', expect.anything()]);
  });

  it('does not push or open a PR when there are no commits ahead of origin/main', async () => {
    const { octokit, calls } = createOctokit();
    const commands: string[] = [];
    const logs: Array<[string, string]> = [];
    const run = async (command: string) => {
      commands.push(command);
      if (command === 'git status --porcelain') return { stdout: '' };
      if (command === 'git rev-list --count origin/main..HEAD') return { stdout: '0\n' };
      if (command === 'git diff --quiet origin/main..HEAD') throw new Error('trees differ');
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
      'git fetch origin main',
      'git status --porcelain',
      'git rev-list --count origin/main..HEAD',
      'git diff --quiet origin/main..HEAD',
    ]);
    expect(calls).toContainEqual(['pulls.list', expect.objectContaining({ state: 'closed' })]);
    expect(calls).not.toContainEqual(['pulls.create', expect.anything()]);
    expect(logs).toContainEqual(['ship', 'not recovering ship-it/23-self-heal: no commits ahead of origin/main']);
  });

  it('aborts before PR creation when git push fails', async () => {
    const { octokit, calls } = createOctokit();
    const logs: Array<[string, string]> = [];
    const run = async (command: string) => {
      if (command === 'git status --porcelain') return { stdout: '' };
      if (command === 'git rev-list --count origin/main..HEAD') return { stdout: '1\n' };
      if (command === 'git diff --quiet origin/main..HEAD') throw new Error('trees differ');
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

    expect(result).toEqual({ ok: false });
    expect(logs).toContainEqual(['ship', 'git push failed (unknown): remote rejected — aborting before PR creation']);
    expect(calls).not.toContainEqual(['pulls.create', expect.anything()]);
  });

  it('does not emit the ready log line or touch the PR when the push fails', async () => {
    const { octokit, calls } = createOctokit();
    const logs: Array<[string, string]> = [];
    const run = async (command: string) => {
      if (command === 'git status --porcelain') return { stdout: '' };
      if (command === 'git rev-list --count origin/main..HEAD') return { stdout: '1\n' };
      if (command === 'git diff --quiet origin/main..HEAD') throw new Error('trees differ');
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

    expect(result).toEqual({ ok: false });
    expect(logs.map(([type]) => type)).not.toContain('ready');
    expect(logs.map(([type]) => type)).not.toContain('recovered');
    expect(calls).not.toContainEqual(['pulls.create', expect.anything()]);
    expect(calls).not.toContainEqual(['issues.createComment', expect.anything()]);
    expect(calls).not.toContainEqual(['pulls.get', expect.anything()]);
    expect(calls).not.toContainEqual(['issues.get', expect.anything()]);
  });

  it('names a non-fast-forward push rejection and logs its stderr', async () => {
    const { octokit, calls } = createOctokit();
    const logs: Array<[string, string]> = [];
    const run = async (command: string) => {
      if (command === 'git status --porcelain') return { stdout: '' };
      if (command === 'git rev-list --count origin/main..HEAD') return { stdout: '1\n' };
      if (command === 'git diff --quiet origin/main..HEAD') throw new Error('trees differ');
      if (command.startsWith('git push')) {
        throw Object.assign(new Error('Command failed: git push'), {
          stderr:
            " ! [rejected]        main -> main (non-fast-forward)\nerror: failed to push some refs to 'https://github.com/on-par/software-factory'\nhint: Updates were rejected because the tip of your current branch is behind\n",
        });
      }
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
    const shipLog = logs.find(([, msg]) => msg.startsWith('git push failed'));
    expect(shipLog?.[1]).toMatch(/^git push failed \(non-fast-forward\): ! \[rejected\]/);
    expect(shipLog?.[1]).toContain('failed to push some refs');
    expect(shipLog?.[1]).toMatch(/— aborting before PR creation$/);
    expect(shipLog?.[1]).not.toContain('\n');
    expect(calls).not.toContainEqual(['pulls.create', expect.anything()]);
  });

  it('distinguishes a network push failure from non-fast-forward', async () => {
    const { octokit, calls } = createOctokit();
    const logs: Array<[string, string]> = [];
    const run = async (command: string) => {
      if (command === 'git status --porcelain') return { stdout: '' };
      if (command === 'git rev-list --count origin/main..HEAD') return { stdout: '1\n' };
      if (command === 'git diff --quiet origin/main..HEAD') throw new Error('trees differ');
      if (command.startsWith('git push')) {
        throw Object.assign(new Error('Command failed: git push'), {
          stderr:
            "fatal: unable to access 'https://github.com/on-par/software-factory/': Could not resolve host: github.com",
        });
      }
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
    const shipLog = logs.find(([, msg]) => msg.startsWith('git push failed'));
    expect(shipLog?.[1]).toContain('git push failed (network):');
    expect(shipLog?.[1]).toContain('Could not resolve host');
    expect(shipLog?.[1]).not.toContain('non-fast-forward');
    expect(calls).not.toContainEqual(['pulls.create', expect.anything()]);
  });

  it('handles a non-Error throw from git push', async () => {
    const { octokit, calls } = createOctokit();
    const logs: Array<[string, string]> = [];
    const run = async (command: string) => {
      if (command === 'git status --porcelain') return { stdout: '' };
      if (command === 'git rev-list --count origin/main..HEAD') return { stdout: '1\n' };
      if (command === 'git diff --quiet origin/main..HEAD') throw new Error('trees differ');
      if (command.startsWith('git push')) throw 'boom';
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
    expect(logs).toContainEqual(['ship', 'git push failed (unknown): boom — aborting before PR creation']);
    expect(calls).not.toContainEqual(['pulls.create', expect.anything()]);
  });

  it('falls back to "no error output" when the push failure carries no text', async () => {
    const { octokit, calls } = createOctokit();
    const logs: Array<[string, string]> = [];
    const run = async (command: string) => {
      if (command === 'git status --porcelain') return { stdout: '' };
      if (command === 'git rev-list --count origin/main..HEAD') return { stdout: '1\n' };
      if (command === 'git diff --quiet origin/main..HEAD') throw new Error('trees differ');
      if (command.startsWith('git push')) throw new Error('');
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
    expect(logs).toContainEqual(['ship', 'git push failed (unknown): no error output — aborting before PR creation']);
    expect(calls).not.toContainEqual(['pulls.create', expect.anything()]);
  });

  it('fails closed without creating a PR when the open-PR lookup errors', async () => {
    const { octokit, calls } = createOctokit();
    octokit.rest.pulls.list = async (args: any) => {
      calls.push(['pulls.list', args]);
      throw new Error('list failed');
    };
    const logs: Array<[string, string]> = [];
    const run = async (command: string) => {
      const remote = remoteHeadStub(command);
      if (remote) return remote;
      if (command === 'git status --porcelain') return { stdout: '' };
      if (command === 'git rev-list --count origin/main..HEAD') return { stdout: '1\n' };
      if (command === 'git diff --quiet origin/main..HEAD') throw new Error('trees differ');
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
    expect(calls).not.toContainEqual(['pulls.create', expect.anything()]);
    expect(
      logs.some(
        ([type, msg]) =>
          type === 'ship' &&
          msg.includes('could not determine whether an open PR exists') &&
          msg.includes('list failed'),
      ),
    ).toBe(true);
  });

  it('builds the PR body with an empty diff stat when computeDiffStat throws', async () => {
    const { octokit, calls } = createOctokit();
    const logs: Array<[string, string]> = [];
    const run = async (command: string) => {
      const remote = remoteHeadStub(command);
      if (remote) return remote;
      if (command === 'git status --porcelain') return { stdout: '' };
      if (command === 'git rev-list --count origin/main..HEAD') return { stdout: '1\n' };
      if (command === 'git diff --quiet origin/main..HEAD') throw new Error('trees differ');
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
      const remote = remoteHeadStub(command);
      if (remote) return remote;
      if (command === 'git status --porcelain') return { stdout: '' };
      if (command === 'git rev-list --count origin/main..HEAD') return { stdout: '1\n' };
      if (command === 'git diff --quiet origin/main..HEAD') throw new Error('trees differ');
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
      const remote = remoteHeadStub(command);
      if (remote) return remote;
      if (command === 'git status --porcelain') return { stdout: '' };
      if (command === 'git rev-list --count origin/main..HEAD') return { stdout: '1\n' };
      if (command === 'git diff --quiet origin/main..HEAD') throw new Error('trees differ');
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

describe('shipPhase remote head verification (#735)', () => {
  function recoveryRun(handleExtra: (command: string) => { stdout: string } | undefined) {
    return async (command: string) => {
      const extra = handleExtra(command);
      if (extra) return extra;
      const remote = remoteHeadStub(command);
      if (remote) return remote;
      if (command === 'git status --porcelain') return { stdout: '' };
      if (command === 'git rev-list --count origin/main..HEAD') return { stdout: '1\n' };
      if (command === 'git diff --quiet origin/main..HEAD') throw new Error('trees differ');
      if (command === 'git diff --stat origin/main...HEAD') return { stdout: ' ship.ts | 12 ++++++++++++\n' };
      return { stdout: '' };
    };
  }

  it('matches → PR is created and both SHAs are logged', async () => {
    const { octokit, calls } = createOctokit();
    const logs: Array<[string, string]> = [];
    const run = recoveryRun(() => undefined);

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
    expect(logs).toContainEqual([
      'ship',
      `remote head ${STUB_HEAD_SHA} matches local HEAD ${STUB_HEAD_SHA} for ship-it/23-self-heal`,
    ]);
  });

  it('mismatch → no PR, non-success, both SHAs logged', async () => {
    const { octokit, calls } = createOctokit();
    const logs: Array<[string, string]> = [];
    const mismatchedSha = 'ffffffffffffffffffffffffffffffffffffffff';
    const run = recoveryRun((command) => {
      if (command === "git ls-remote --heads origin 'ship-it/23-self-heal'") {
        return { stdout: `${mismatchedSha}\trefs/heads/ship-it/23-self-heal\n` };
      }
      return undefined;
    });

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
    expect(calls).not.toContainEqual(['pulls.create', expect.anything()]);
    expect(logs).toContainEqual([
      'ship',
      `remote head ${mismatchedSha} does not match local HEAD ${STUB_HEAD_SHA} for ship-it/23-self-heal — aborting before PR creation`,
    ]);
    expect(logs.map(([type]) => type)).not.toContain('ready');
  });

  it('git ls-remote throws → abort', async () => {
    const { octokit, calls } = createOctokit();
    const logs: Array<[string, string]> = [];
    const run = recoveryRun((command) => {
      if (command === "git ls-remote --heads origin 'ship-it/23-self-heal'") {
        throw Object.assign(new Error('Command failed: git ls-remote'), {
          stderr: 'fatal: could not read from remote repository\n',
        });
      }
      return undefined;
    });

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
    expect(calls).not.toContainEqual(['pulls.create', expect.anything()]);
    expect(
      logs.some(
        ([type, msg]) =>
          type === 'ship' &&
          msg.includes('could not verify the remote head for ship-it/23-self-heal') &&
          msg.includes('fatal: could not read from remote repository'),
      ),
    ).toBe(true);
  });

  it('git ls-remote returns no matching ref → abort', async () => {
    const { octokit, calls } = createOctokit();
    const logs: Array<[string, string]> = [];
    const run = recoveryRun((command) => {
      if (command === "git ls-remote --heads origin 'ship-it/23-self-heal'") return { stdout: '' };
      return undefined;
    });

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
    expect(calls).not.toContainEqual(['pulls.create', expect.anything()]);
    expect(
      logs.some(([type, msg]) => type === 'ship' && msg.includes('no refs/heads/ship-it/23-self-heal on origin')),
    ).toBe(true);
  });

  it('git rev-parse HEAD throws → abort before ls-remote is even run', async () => {
    const { octokit, calls } = createOctokit();
    const logs: Array<[string, string]> = [];
    const commands: string[] = [];
    const run = async (command: string) => {
      commands.push(command);
      if (command === 'git rev-parse HEAD') throw new Error('fatal: not a git repository');
      const remote = remoteHeadStub(command);
      if (remote) return remote;
      if (command === 'git status --porcelain') return { stdout: '' };
      if (command === 'git rev-list --count origin/main..HEAD') return { stdout: '1\n' };
      if (command === 'git diff --quiet origin/main..HEAD') throw new Error('trees differ');
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
    expect(calls).not.toContainEqual(['pulls.create', expect.anything()]);
    expect(commands.some((c) => c.startsWith('git ls-remote'))).toBe(false);
  });

  it('an unrelated ref in the ls-remote listing does not fool the comparison', async () => {
    const { octokit, calls } = createOctokit();
    const logs: Array<[string, string]> = [];
    const run = recoveryRun((command) => {
      if (command === "git ls-remote --heads origin 'ship-it/23-self-heal'") {
        return {
          stdout: `deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\trefs/heads/other/ship-it/23-self-heal\n${STUB_HEAD_SHA}\trefs/heads/ship-it/23-self-heal\n`,
        };
      }
      return undefined;
    });

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
});

describe('shipPhase inline work source (#507)', () => {
  it('titles and bodies the PR from a non-github work request without fetching the issue', async () => {
    const { octokit, calls } = createOctokit();
    octokit.rest.issues.get = async () => {
      throw new Error('issues.get should never be called for an inline work source');
    };
    const run = async (command: string) => {
      const remote = remoteHeadStub(command);
      if (remote) return remote;
      if (command === 'git status --porcelain') return { stdout: '' };
      if (command === 'git rev-list --count origin/main..HEAD') return { stdout: '1\n' };
      if (command === 'git diff --quiet origin/main..HEAD') throw new Error('trees differ');
      if (command === 'git diff --stat origin/main...HEAD') return { stdout: ' brief.ts | 3 +++\n' };
      return { stdout: '' };
    };

    const result = await shipPhase({
      issue: 9000123,
      repo: 'on-par/software-factory',
      worktree: '/repo-factory-9000123',
      branch: 'ship-it/9000123-add-a-widget',
      octokit: octokit as any,
      watchCI: false,
      log: () => {},
      run,
      work: { id: 'local-brief:brief.md#abc123def456', kind: 'local-brief', title: 'Add a widget' },
    });

    expect(result).toEqual({ ok: true, prNumber: 123 });
    expect(calls).toContainEqual([
      'pulls.create',
      expect.objectContaining({
        title: 'Add a widget',
        body: expect.stringContaining('Implements local brief `local-brief:brief.md#abc123def456`'),
      }),
    ]);
    const [, createArgs] = calls.find(([name]) => name === 'pulls.create') as [string, any];
    expect(createArgs.body).not.toContain('Closes #');
  });

  it('behaves exactly like today when work is a github-issue request (run-issue passthrough is inert)', async () => {
    const { octokit, calls } = createOctokit();
    const run = async (command: string) => {
      const remote = remoteHeadStub(command);
      if (remote) return remote;
      if (command === 'git status --porcelain') return { stdout: '' };
      if (command === 'git rev-list --count origin/main..HEAD') return { stdout: '1\n' };
      if (command === 'git diff --quiet origin/main..HEAD') throw new Error('trees differ');
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
      log: () => {},
      run,
      work: { id: 'github-issue:on-par/software-factory#23', kind: 'github-issue', title: 'Self-heal committed work' },
    });

    expect(result).toEqual({ ok: true, prNumber: 123 });
    expect(calls).toContainEqual([
      'pulls.create',
      expect.objectContaining({
        title: 'Self-heal committed work (#23)',
        body: expect.stringContaining('Closes #23'),
      }),
    ]);
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

      expect(result).toEqual({ ok: true, prNumber: 123, ciOutcome: 'success' });
      expect(logs).toContainEqual(['ship', 'CI green for PR #123']);
      expect(logs.some(([, msg]) => msg.includes('CI failed'))).toBe(false);
      expect(logs).toContainEqual(['ready', 'PR #123 ready for review']);
      expect(callCount()).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails and leaves the PR unready once a check run fails', async () => {
    const { octokit, calls, callCount } = createWatchOctokit([pending, oneFailure]);
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

      expect(result).toEqual({
        ok: false,
        prNumber: 123,
        reason: 'CI failed for PR #123',
        ciOutcome: 'failure',
      });
      expect(logs).toContainEqual(['ship', 'CI failed for PR #123']);
      expect(logs.some(([, msg]) => msg.includes('CI green'))).toBe(false);
      expect(logs).not.toContainEqual(['ready', 'PR #123 ready for review']);
      expect(calls.some(([name]) => name === 'pulls.get')).toBe(false);
      expect(calls.some(([name]) => name === 'graphql')).toBe(false);
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

      expect(result).toEqual({ ok: true, prNumber: 123, ciOutcome: 'timeout' });
      expect(logs.some(([, msg]) => msg.includes('CI green'))).toBe(false);
      expect(logs.some(([, msg]) => msg.includes('CI failed'))).toBe(false);
      expect(logs).toContainEqual(['ready', 'PR #123 ready for review']);
      expect(callCount()).toBeGreaterThan(0);
      expect(callCount()).toBeLessThanOrEqual(15); // backoff → far fewer polls than fixed 15s (~40)
    } finally {
      vi.useRealTimers();
    }
  });

  it('still logs ready when watching CI throws on every poll (fail-closed retry exhausts as timeout, never rejects)', async () => {
    const { octokit } = createWatchOctokit([allSuccess]);
    octokit.rest.checks.listForRef = async () => {
      throw new Error('checks API unavailable');
    };
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

      expect(result).toEqual({ ok: true, prNumber: 123, ciOutcome: 'timeout' });
      expect(logs).toContainEqual(['ready', 'PR #123 ready for review']);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('shipPhase evidence pack', () => {
  it('posts an evidence pack comment on the happy path and logs evidence', async () => {
    const { octokit, calls } = createOctokit();
    const logs: Array<[string, string]> = [];
    const run = async (command: string) => {
      const remote = remoteHeadStub(command);
      if (remote) return remote;
      if (command === 'git status --porcelain') return { stdout: '' };
      if (command === 'git rev-list --count origin/main..HEAD') return { stdout: '1\n' };
      if (command === 'git diff --quiet origin/main..HEAD') throw new Error('trees differ');
      if (command === 'git diff --stat origin/main...HEAD') return { stdout: ' ship.ts | 12 ++++++++++++\n' };
      return { stdout: '' };
    };
    const checkSummary = { failures: 0, passes: 3, skips: 0, total: 3, results: [] };

    const result = await shipPhase({
      issue: 23,
      repo: 'on-par/software-factory',
      worktree: '/repo-factory-23',
      branch: 'ship-it/23-self-heal',
      octokit: octokit as any,
      watchCI: false,
      log: (type, msg) => logs.push([type, msg]),
      run,
      checkSummary,
      reworkRounds: 1,
      specPath: '/nonexistent/spec.md',
      eventsFile: '/nonexistent/events.ndjson',
      startedAt: new Date().toISOString(),
      logsDir: '/nonexistent/logs',
    });

    expect(result).toEqual({ ok: true, prNumber: 123 });
    expect(calls).toContainEqual([
      'issues.createComment',
      expect.objectContaining({
        owner: 'on-par',
        repo: 'software-factory',
        issue_number: 123,
        body: expect.stringContaining('Evidence pack'),
      }),
    ]);
    expect(logs).toContainEqual(['evidence', 'posted evidence pack to PR #123']);
  });

  it('includes rework rounds in the posted comment body (AC-2)', async () => {
    const { octokit, calls } = createOctokit();
    const logs: Array<[string, string]> = [];
    const run = async (command: string) => {
      const remote = remoteHeadStub(command);
      if (remote) return remote;
      if (command === 'git status --porcelain') return { stdout: '' };
      if (command === 'git rev-list --count origin/main..HEAD') return { stdout: '1\n' };
      if (command === 'git diff --quiet origin/main..HEAD') throw new Error('trees differ');
      if (command === 'git diff --stat origin/main...HEAD') return { stdout: ' ship.ts | 12 ++++++++++++\n' };
      return { stdout: '' };
    };
    const checkSummary = { failures: 0, passes: 3, skips: 0, total: 3, results: [] };

    await shipPhase({
      issue: 23,
      repo: 'on-par/software-factory',
      worktree: '/repo-factory-23',
      branch: 'ship-it/23-self-heal',
      octokit: octokit as any,
      watchCI: false,
      log: (type, msg) => logs.push([type, msg]),
      run,
      checkSummary,
      reworkRounds: 2,
    });

    expect(calls).toContainEqual([
      'issues.createComment',
      expect.objectContaining({ body: expect.stringContaining('Rework rounds: 2') }),
    ]);
  });

  it('never blocks the ship when posting the evidence pack throws', async () => {
    const { octokit, calls } = createOctokit();
    octokit.rest.issues.createComment = async (args: any) => {
      calls.push(['issues.createComment', args]);
      throw new Error('comment failed');
    };
    const logs: Array<[string, string]> = [];
    const run = async (command: string) => {
      const remote = remoteHeadStub(command);
      if (remote) return remote;
      if (command === 'git status --porcelain') return { stdout: '' };
      if (command === 'git rev-list --count origin/main..HEAD') return { stdout: '1\n' };
      if (command === 'git diff --quiet origin/main..HEAD') throw new Error('trees differ');
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
    expect(logs.some(([type]) => type === 'evidence')).toBe(false);
  });
});

describe('shipPhase PR description', () => {
  it('opens the PR with the frozen spec goal, approach, and tests ahead of the diff stat', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ship-pr-body-test-'));
    try {
      const specPath = join(dir, 'issue-23.md');
      await writeFile(
        specPath,
        [
          '---',
          'route: codex',
          '---',
          '# Spec: Self-heal committed work (#23)',
          '## Goal',
          'A crashed run leaves committed work with no PR. Recover it on the next run.',
          '## Files / approach',
          'Detect commits ahead of main in `ship.ts` and open the PR for them.',
          '## Tests',
          'Cover the recovery path in `ship.test.ts`.',
          '## Non-goals',
          'Recovering uncommitted work.',
          '',
        ].join('\n'),
      );
      const { octokit, calls } = createOctokit();
      const run = async (command: string) => {
        const remote = remoteHeadStub(command);
        if (remote) return remote;
        if (command === 'git rev-list --count origin/main..HEAD') return { stdout: '1\n' };
        if (command === 'git diff --quiet origin/main..HEAD') throw new Error('trees differ');
        if (command === 'git diff --stat origin/main...HEAD') return { stdout: ' ship.ts | 12 ++++++++++++\n' };
        return { stdout: '' };
      };

      const result = await shipPhase({
        issue: 23,
        repo: 'on-par/software-factory',
        worktree: dir,
        branch: 'ship-it/23-self-heal',
        octokit: octokit as any,
        watchCI: false,
        log: () => {},
        run,
        specPath,
      });

      expect(result).toEqual({ ok: true, prNumber: 123 });
      const body: string = calls.find((c) => c[0] === 'pulls.create')[1].body;
      expect(body).toContain('## Why\nA crashed run leaves committed work with no PR.');
      expect(body).toContain('## How\nDetect commits ahead of main in `ship.ts`');
      expect(body).toContain('## Tests\nCover the recovery path in `ship.test.ts`.');
      expect(body).not.toContain('route: codex');
      expect(body).not.toContain('Recovering uncommitted work.');
      expect(body.indexOf('## Why')).toBeLessThan(body.indexOf('ship.ts | 12'));
      expect(body).toContain('Closes #23');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('shipPhase approval gate', () => {
  it('approves: gate resolving approved:true lets ship proceed and logs ship, then approval_requested, then approval_granted', async () => {
    const { octokit, calls } = createOctokit();
    const logs: Array<[string, string]> = [];
    const diffStatCalls: string[] = [];
    const run = async (command: string) => {
      const remote = remoteHeadStub(command);
      if (remote) return remote;
      if (command === 'git status --porcelain') return { stdout: '' };
      if (command === 'git rev-list --count origin/main..HEAD') return { stdout: '1\n' };
      if (command === 'git diff --quiet origin/main..HEAD') throw new Error('trees differ');
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
    // phase_started (#1321) precedes every phase-domain event, including 'ship'.
    expect(logs[0][0]).toBe('phase_started');
    expect(shipIdx).toBe(1);
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
      const remote = remoteHeadStub(command);
      if (remote) return remote;
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
    // A 'ship'-typed event fires first (right after phase_started, #1321) so a denial
    // doesn't misreport the TUI's failed phase as CHECK/BUILD.
    expect(logs[0][0]).toBe('phase_started');
    expect(logs[1]).toEqual(['ship', 'Starting ship phase for ship-it/23-self-heal']);
  });

  it('denies with the default "denied" reason when the gate response omits one', async () => {
    const { octokit, calls } = createOctokit();
    const logs: Array<[string, string]> = [];
    const run = async (command: string) => {
      const remote = remoteHeadStub(command);
      if (remote) return remote;
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
      const remote = remoteHeadStub(command);
      if (remote) return remote;
      if (command === 'git status --porcelain') return { stdout: '' };
      if (command === 'git rev-list --count origin/main..HEAD') return { stdout: '1\n' };
      if (command === 'git diff --quiet origin/main..HEAD') throw new Error('trees differ');
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

describe('shipPhase never records ADRs', () => {
  it('ignores a leftover <spec>.adr.json from an older run: no docs/adr write, no git add/commit, no adr_* logs', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'ship-no-adr-test-'));
    try {
      await mkdir(join(worktree, 'docs', 'adr'), { recursive: true });
      const specPath = join(worktree, 'issue-482.md');
      await writeFile(
        join(worktree, 'issue-482.adr.json'),
        JSON.stringify([{ title: 'Stale draft', context: 'c', decision: 'd', consequences: 'q', status: 'proposed' }]),
      );

      const { octokit } = createOctokit();
      const commands: string[] = [];
      const logs: Array<[string, string]> = [];
      const run = async (command: string) => {
        commands.push(command);
        const remote = remoteHeadStub(command);
        if (remote) return remote;
        if (command === 'git rev-list --count origin/main..HEAD') return { stdout: '1\n' };
        if (command === 'git diff --quiet origin/main..HEAD') throw new Error('trees differ');
        return { stdout: '' };
      };

      const result = await shipPhase({
        issue: 482,
        repo: 'on-par/software-factory',
        worktree,
        branch: 'ship-it/482-adr-writer',
        octokit: octokit as any,
        watchCI: false,
        log: (type, msg) => logs.push([type, msg]),
        run,
        specPath,
      });

      expect(result).toEqual({ ok: true, prNumber: 123 });
      expect(await readdir(join(worktree, 'docs', 'adr'))).toEqual([]);
      expect(commands.some((c) => c.startsWith('git add') || c.startsWith('git commit'))).toBe(false);
      expect(logs.some(([type]) => type.startsWith('adr_'))).toBe(false);
    } finally {
      await rm(worktree, { recursive: true, force: true });
    }
  });
});

describe('shipPhase duplicate-PR guard (#520)', () => {
  function createMergedPROctokit(closedPRs: any[] = [{ number: 518, merged_at: '2026-07-29T05:39:10Z' }]) {
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
            return { data: args.state === 'closed' ? closedPRs : [] };
          },
          create: async (args: any) => {
            calls.push(['pulls.create', args]);
            return { data: { number: 123 } };
          },
          get: async (args: any) => {
            calls.push(['pulls.get', args]);
            return { data: { draft: true, node_id: 'PR_1' } };
          },
        },
        issues: {
          get: async (args: any) => {
            calls.push(['issues.get', args]);
            return { data: { title: 'Self-heal committed work' } };
          },
          createComment: async (args: any) => {
            calls.push(['issues.createComment', args]);
            return { data: { id: 1 } };
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

  it('returns already-delivered without pushing when a squash-merge retry lands on an identical tree (the reported bug)', async () => {
    const { octokit, calls } = createMergedPROctokit();
    const commands: string[] = [];
    const logs: Array<[string, string]> = [];
    const run = async (command: string) => {
      commands.push(command);
      const remote = remoteHeadStub(command);
      if (remote) return remote;
      if (command === 'git status --porcelain') return { stdout: '' };
      if (command === 'git rev-list --count origin/main..HEAD') return { stdout: '2\n' };
      if (command === 'git diff --quiet origin/main..HEAD') return { stdout: '' };
      return { stdout: '' };
    };

    const result = await shipPhase({
      issue: 511,
      repo: 'on-par/software-factory',
      worktree: '/repo-factory-511',
      branch: 'ship-it/511-baseline',
      octokit: octokit as any,
      watchCI: false,
      log: (type, msg) => logs.push([type, msg]),
      run,
    });

    expect(result).toEqual({ ok: true, prNumber: 518, alreadyDelivered: true });
    expect(commands).toContain('git fetch origin main');
    expect(commands.some((c) => c.startsWith('git push'))).toBe(false);
    expect(calls).not.toContainEqual(['pulls.create', expect.anything()]);
    expect(logs).toContainEqual(['ship', expect.stringContaining('already delivered by merged PR #518')]);
  });

  it('refreshes the stale remote-tracking ref before the landed check, so a fresh fetch is what reveals delivery', async () => {
    const { octokit, calls } = createMergedPROctokit();
    let fetched = false;
    const run = async (command: string) => {
      const remote = remoteHeadStub(command);
      if (remote) return remote;
      if (command === 'git fetch origin main') {
        fetched = true;
        return { stdout: '' };
      }
      if (command === 'git status --porcelain') return { stdout: '' };
      if (command === 'git rev-list --count origin/main..HEAD') return { stdout: '2\n' };
      if (command === 'git diff --quiet origin/main..HEAD') {
        if (fetched) return { stdout: '' };
        throw new Error('stale ref shows differences');
      }
      return { stdout: '' };
    };

    const result = await shipPhase({
      issue: 511,
      repo: 'on-par/software-factory',
      worktree: '/repo-factory-511',
      branch: 'ship-it/511-baseline',
      octokit: octokit as any,
      watchCI: false,
      log: () => {},
      run,
    });

    expect(result).toEqual({ ok: true, prNumber: 518, alreadyDelivered: true });
    expect(calls).not.toContainEqual(['pulls.create', expect.anything()]);
  });

  it('still refuses to duplicate when the tree is landed but no merged PR is found', async () => {
    const { octokit, calls } = createMergedPROctokit([]);
    const commands: string[] = [];
    const logs: Array<[string, string]> = [];
    const run = async (command: string) => {
      commands.push(command);
      const remote = remoteHeadStub(command);
      if (remote) return remote;
      if (command === 'git status --porcelain') return { stdout: '' };
      if (command === 'git rev-list --count origin/main..HEAD') return { stdout: '2\n' };
      if (command === 'git diff --quiet origin/main..HEAD') return { stdout: '' };
      return { stdout: '' };
    };

    const result = await shipPhase({
      issue: 511,
      repo: 'on-par/software-factory',
      worktree: '/repo-factory-511',
      branch: 'ship-it/511-baseline',
      octokit: octokit as any,
      watchCI: false,
      log: (type, msg) => logs.push([type, msg]),
      run,
    });

    expect(result).toEqual({ ok: true, alreadyDelivered: true });
    expect(result.prNumber).toBeUndefined();
    expect(commands.some((c) => c.startsWith('git push'))).toBe(false);
    expect(calls).not.toContainEqual(['pulls.create', expect.anything()]);
    expect(logs).toContainEqual(['ship', expect.stringContaining('HEAD tree matches origin/main')]);
  });

  it('reports delivered for a merge-commit merge (ahead-count 0 after fetch) with a prior merged PR', async () => {
    const { octokit, calls } = createMergedPROctokit();
    const logs: Array<[string, string]> = [];
    const run = async (command: string) => {
      const remote = remoteHeadStub(command);
      if (remote) return remote;
      if (command === 'git status --porcelain') return { stdout: '' };
      if (command === 'git rev-list --count origin/main..HEAD') return { stdout: '0\n' };
      if (command === 'git diff --quiet origin/main..HEAD') throw new Error('trees differ');
      return { stdout: '' };
    };

    const result = await shipPhase({
      issue: 511,
      repo: 'on-par/software-factory',
      worktree: '/repo-factory-511',
      branch: 'ship-it/511-baseline',
      octokit: octokit as any,
      watchCI: false,
      log: (type, msg) => logs.push([type, msg]),
      run,
    });

    expect(result).toEqual({ ok: true, prNumber: 518, alreadyDelivered: true });
    expect(calls).not.toContainEqual(['pulls.create', expect.anything()]);
  });

  it('still opens a new PR for genuinely new commits even when an older merged PR exists for the branch', async () => {
    const { octokit, calls } = createMergedPROctokit();
    const commands: string[] = [];
    const run = async (command: string) => {
      commands.push(command);
      const remote = remoteHeadStub(command);
      if (remote) return remote;
      if (command === 'git status --porcelain') return { stdout: '' };
      if (command === 'git rev-list --count origin/main..HEAD') return { stdout: '1\n' };
      if (command === 'git diff --quiet origin/main..HEAD') throw new Error('trees differ');
      if (command === 'git diff --stat origin/main...HEAD') return { stdout: ' ship.ts | 3 +++\n' };
      return { stdout: '' };
    };

    const result = await shipPhase({
      issue: 511,
      repo: 'on-par/software-factory',
      worktree: '/repo-factory-511',
      branch: 'ship-it/511-baseline',
      octokit: octokit as any,
      watchCI: false,
      log: () => {},
      run,
    });

    expect(result).toEqual({ ok: true, prNumber: 123 });
    expect(commands).toContainEqual("git push -u origin 'ship-it/511-baseline'");
    expect(calls).toContainEqual(['pulls.create', expect.anything()]);
  });

  it('degrades gracefully when git fetch origin main fails, still recovering normally', async () => {
    const { octokit, calls } = createMergedPROctokit();
    const logs: Array<[string, string]> = [];
    const run = async (command: string) => {
      const remote = remoteHeadStub(command);
      if (remote) return remote;
      if (command === 'git fetch origin main') throw new Error('network unreachable');
      if (command === 'git status --porcelain') return { stdout: '' };
      if (command === 'git rev-list --count origin/main..HEAD') return { stdout: '1\n' };
      if (command === 'git diff --quiet origin/main..HEAD') throw new Error('trees differ');
      if (command === 'git diff --stat origin/main...HEAD') return { stdout: ' ship.ts | 3 +++\n' };
      return { stdout: '' };
    };

    const result = await shipPhase({
      issue: 511,
      repo: 'on-par/software-factory',
      worktree: '/repo-factory-511',
      branch: 'ship-it/511-baseline',
      octokit: octokit as any,
      watchCI: false,
      log: (type, msg) => logs.push([type, msg]),
      run,
    });

    expect(result).toEqual({ ok: true, prNumber: 123 });
    expect(calls).toContainEqual(['pulls.create', expect.anything()]);
    expect(logs).toContainEqual(['ship', expect.stringContaining('git fetch origin main failed')]);
  });
});

describe('findOpenPR / findMergedPR (#641)', () => {
  it('findOpenPR: found', async () => {
    const { octokit } = createOctokit();
    octokit.rest.pulls.list = (async () => ({ data: [{ number: 7 }] })) as any;
    const result = await findOpenPR(octokit as any, 'on-par', 'software-factory', 'ship-it/23-x');
    expect(result).toEqual({ status: 'found', prNumber: 7 });
  });

  it('findOpenPR: absent', async () => {
    const { octokit } = createOctokit();
    octokit.rest.pulls.list = async () => ({ data: [] });
    const result = await findOpenPR(octokit as any, 'on-par', 'software-factory', 'ship-it/23-x');
    expect(result).toEqual({ status: 'absent' });
  });

  it('findOpenPR: error is never reported as absent', async () => {
    const { octokit } = createOctokit();
    octokit.rest.pulls.list = async () => {
      throw new Error('boom');
    };
    const result = await findOpenPR(octokit as any, 'on-par', 'software-factory', 'ship-it/23-x');
    expect(result).toEqual({ status: 'error', detail: expect.stringContaining('boom') });
    expect(result).not.toEqual({ status: 'absent' });
  });

  it('findMergedPR: found', async () => {
    const { octokit } = createOctokit();
    octokit.rest.pulls.list = (async () => ({ data: [{ number: 9, merged_at: '2026-08-01T00:00:00Z' }] })) as any;
    const result = await findMergedPR(octokit as any, 'on-par', 'software-factory', 'ship-it/23-x');
    expect(result).toEqual({ status: 'found', prNumber: 9 });
  });

  it('findMergedPR: absent (closed but not merged)', async () => {
    const { octokit } = createOctokit();
    octokit.rest.pulls.list = (async () => ({ data: [{ number: 9, merged_at: null }] })) as any;
    const result = await findMergedPR(octokit as any, 'on-par', 'software-factory', 'ship-it/23-x');
    expect(result).toEqual({ status: 'absent' });
  });

  it('findMergedPR: error', async () => {
    const { octokit } = createOctokit();
    octokit.rest.pulls.list = async () => {
      throw new Error('boom');
    };
    const result = await findMergedPR(octokit as any, 'on-par', 'software-factory', 'ship-it/23-x');
    expect(result).toEqual({ status: 'error', detail: expect.stringContaining('boom') });
  });
});

describe('shipPhase ambiguous-lookup fail-closed (#641)', () => {
  it('fails closed when the merged-PR lookup errors and git has not proven the branch landed', async () => {
    const { octokit, calls } = createOctokit();
    let listCalls = 0;
    octokit.rest.pulls.list = async (args: any) => {
      calls.push(['pulls.list', args]);
      listCalls++;
      if (listCalls === 1) return { data: [] };
      throw new Error('list failed');
    };
    const logs: Array<[string, string]> = [];
    const run = async (command: string) => {
      const remote = remoteHeadStub(command);
      if (remote) return remote;
      if (command === 'git status --porcelain') return { stdout: '' };
      if (command === 'git rev-list --count origin/main..HEAD') return { stdout: '0\n' };
      if (command === 'git diff --quiet origin/main..HEAD') throw new Error('trees differ');
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
    expect(
      logs.some(([type, msg]) => type === 'ship' && msg.includes('could not determine whether it was already merged')),
    ).toBe(true);
  });

  it('a proven-landed tree overrides a merged-PR lookup error', async () => {
    const { octokit, calls } = createOctokit();
    let listCalls = 0;
    octokit.rest.pulls.list = async (args: any) => {
      calls.push(['pulls.list', args]);
      listCalls++;
      if (listCalls === 1) return { data: [] };
      throw new Error('list failed');
    };
    const run = async (command: string) => {
      const remote = remoteHeadStub(command);
      if (remote) return remote;
      if (command === 'git status --porcelain') return { stdout: '' };
      if (command === 'git rev-list --count origin/main..HEAD') return { stdout: '0\n' };
      if (command === 'git diff --quiet origin/main..HEAD') return { stdout: '' };
      return { stdout: '' };
    };

    const result = await shipPhase({
      issue: 23,
      repo: 'on-par/software-factory',
      worktree: '/repo-factory-23',
      branch: 'ship-it/23-self-heal',
      octokit: octokit as any,
      watchCI: false,
      log: () => {},
      run,
    });

    expect(result).toEqual({ ok: true, alreadyDelivered: true });
    expect(result.prNumber).toBeUndefined();
    expect(calls).not.toContainEqual(['pulls.create', expect.anything()]);
  });
});

describe('shipPhase pulls.create 422 already-exists recovery (#641)', () => {
  it('re-queries and reuses the existing PR when pulls.create 422s as already-exists', async () => {
    const { octokit, calls } = createOctokit();
    let listCalls = 0;
    octokit.rest.pulls.list = (async (args: any) => {
      calls.push(['pulls.list', args]);
      listCalls++;
      return listCalls === 1 ? { data: [] } : { data: [{ number: 456 }] };
    }) as any;
    octokit.rest.pulls.create = async (args: any) => {
      calls.push(['pulls.create', args]);
      throw Object.assign(new Error('Validation Failed'), {
        status: 422,
        response: { data: { errors: [{ message: 'A pull request already exists for on-par:ship-it/23-x.' }] } },
      });
    };
    const logs: Array<[string, string]> = [];
    const run = async (command: string) => {
      const remote = remoteHeadStub(command);
      if (remote) return remote;
      if (command === 'git status --porcelain') return { stdout: '' };
      if (command === 'git rev-list --count origin/main..HEAD') return { stdout: '1\n' };
      if (command === 'git diff --quiet origin/main..HEAD') throw new Error('trees differ');
      if (command === 'git diff --stat origin/main...HEAD') return { stdout: ' ship.ts | 3 +++\n' };
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

    expect(result).toEqual({ ok: true, prNumber: 456 });
    expect(logs.some(([type, msg]) => type === 'recovered' && msg.includes('already existed for'))).toBe(true);
  });

  it('propagates a non-422 pulls.create rejection unchanged', async () => {
    const { octokit } = createOctokit();
    octokit.rest.pulls.create = async () => {
      throw Object.assign(new Error('Internal Server Error'), { status: 500 });
    };
    const run = async (command: string) => {
      const remote = remoteHeadStub(command);
      if (remote) return remote;
      if (command === 'git status --porcelain') return { stdout: '' };
      if (command === 'git rev-list --count origin/main..HEAD') return { stdout: '1\n' };
      if (command === 'git diff --quiet origin/main..HEAD') throw new Error('trees differ');
      if (command === 'git diff --stat origin/main...HEAD') return { stdout: ' ship.ts | 3 +++\n' };
      return { stdout: '' };
    };

    await expect(
      shipPhase({
        issue: 23,
        repo: 'on-par/software-factory',
        worktree: '/repo-factory-23',
        branch: 'ship-it/23-self-heal',
        octokit: octokit as any,
        watchCI: false,
        log: () => {},
        run,
      }),
    ).rejects.toThrow('Internal Server Error');
  });

  it('propagates a 422 whose message is not an already-exists case', async () => {
    const { octokit } = createOctokit();
    octokit.rest.pulls.create = async () => {
      throw Object.assign(new Error('No commits between main and ship-it/23-x'), { status: 422 });
    };
    const run = async (command: string) => {
      const remote = remoteHeadStub(command);
      if (remote) return remote;
      if (command === 'git status --porcelain') return { stdout: '' };
      if (command === 'git rev-list --count origin/main..HEAD') return { stdout: '1\n' };
      if (command === 'git diff --quiet origin/main..HEAD') throw new Error('trees differ');
      if (command === 'git diff --stat origin/main...HEAD') return { stdout: ' ship.ts | 3 +++\n' };
      return { stdout: '' };
    };

    await expect(
      shipPhase({
        issue: 23,
        repo: 'on-par/software-factory',
        worktree: '/repo-factory-23',
        branch: 'ship-it/23-self-heal',
        octokit: octokit as any,
        watchCI: false,
        log: () => {},
        run,
      }),
    ).rejects.toThrow('No commits between main and ship-it/23-x');
  });

  it('fails closed when re-querying after a 422 already-exists finds nothing', async () => {
    const { octokit, calls } = createOctokit();
    octokit.rest.pulls.list = async (args: any) => {
      calls.push(['pulls.list', args]);
      return { data: [] };
    };
    octokit.rest.pulls.create = async (args: any) => {
      calls.push(['pulls.create', args]);
      throw Object.assign(new Error('Validation Failed'), {
        status: 422,
        response: { data: { errors: [{ message: 'A pull request already exists for on-par:ship-it/23-x.' }] } },
      });
    };
    const logs: Array<[string, string]> = [];
    const run = async (command: string) => {
      const remote = remoteHeadStub(command);
      if (remote) return remote;
      if (command === 'git status --porcelain') return { stdout: '' };
      if (command === 'git rev-list --count origin/main..HEAD') return { stdout: '1\n' };
      if (command === 'git diff --quiet origin/main..HEAD') throw new Error('trees differ');
      if (command === 'git diff --stat origin/main...HEAD') return { stdout: ' ship.ts | 3 +++\n' };
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
    expect(logs.some(([type, msg]) => type === 'ship' && msg.includes('re-querying did not find it'))).toBe(true);
  });
});

describe('shipPhase lifecycle events', () => {
  it('emits started then done on the success path, validated against the shared schema', async () => {
    const { octokit } = createOctokit();
    const run = async (command: string) => {
      const remote = remoteHeadStub(command);
      if (remote) return remote;
      if (command === 'git status --porcelain') return { stdout: '' };
      if (command === 'git rev-list --count origin/main..HEAD') return { stdout: '1\n' };
      if (command === 'git diff --quiet origin/main..HEAD') throw new Error('trees differ');
      if (command === 'git diff --stat origin/main...HEAD') return { stdout: ' ship.ts | 12 ++++++++++++\n' };
      return { stdout: '' };
    };
    const bus = createLifecycleBus();
    const received: any[] = [];
    bus.on((e) => received.push(e));

    await shipPhase({
      issue: 591,
      repo: 'on-par/software-factory',
      worktree: '/repo-factory-591',
      branch: 'ship-it/591-lifecycle',
      octokit: octokit as any,
      watchCI: false,
      log: () => {},
      run,
      bus,
      laneId: 'lane-1',
    });

    expect(received.map((e) => ({ phase: e.phase, status: e.status }))).toEqual([
      { phase: 'ship', status: 'started' },
      { phase: 'ship', status: 'done' },
    ]);
    expect(received.every((e) => e.laneId === 'lane-1')).toBe(true);
    expect(received.every((e) => e.issueId === '591')).toBe(true);
    expect(received.every((e) => e.worktreePath === '/repo-factory-591')).toBe(true);
    for (const event of received) {
      expect(() => LaneLifecycleEventSchema.parse(event)).not.toThrow();
    }
  });

  it('emits started then failed when there are no commits ahead of origin/main', async () => {
    const { octokit } = createOctokit();
    const run = async (command: string) => {
      if (command === 'git status --porcelain') return { stdout: '' };
      if (command === 'git rev-list --count origin/main..HEAD') return { stdout: '0\n' };
      if (command === 'git diff --quiet origin/main..HEAD') throw new Error('trees differ');
      return { stdout: '' };
    };
    const bus = createLifecycleBus();
    const received: any[] = [];
    bus.on((e) => received.push(e));

    await shipPhase({
      issue: 592,
      repo: 'on-par/software-factory',
      worktree: '/repo-factory-592',
      branch: 'ship-it/592-lifecycle',
      octokit: octokit as any,
      watchCI: false,
      log: () => {},
      run,
      bus,
      laneId: 'lane-1',
    });

    expect(received.map((e) => e.status)).toEqual(['started', 'failed']);
    expect(received[1].detail.length).toBeGreaterThan(0);
  });
});

describe('shipPhase stale remote branch leased push (#1869)', () => {
  const BRANCH = 'ship-it/23-self-heal';
  const RECORDED = 'b'.repeat(40);
  const LS_REMOTE = `git ls-remote --heads origin '${BRANCH}'`;

  /** `before` is what ls-remote returns until a push command is seen; STUB_HEAD_SHA after. */
  function staleRun(
    before: { stdout: string } | Error,
    state: { commands: string[]; pushed: boolean },
    pushError?: Error,
  ) {
    return async (command: string) => {
      state.commands.push(command);
      if (command.startsWith('git push')) {
        if (pushError) throw pushError;
        state.pushed = true;
        return { stdout: '' };
      }
      if (command === LS_REMOTE && !state.pushed) {
        if (before instanceof Error) throw before;
        return before;
      }
      const remote = remoteHeadStub(command);
      if (remote) return remote;
      if (command === 'git status --porcelain') return { stdout: '' };
      if (command === 'git rev-list --count origin/main..HEAD') return { stdout: '1\n' };
      if (command === 'git diff --quiet origin/main..HEAD') throw new Error('trees differ');
      if (command === 'git diff --stat origin/main...HEAD') return { stdout: ' ship.ts | 12 ++++++++++++\n' };
      return { stdout: '' };
    };
  }

  const at = (sha: string) => ({ stdout: `${sha}\trefs/heads/${BRANCH}\n` });

  async function ship(run: (c: string) => Promise<{ stdout: string }>) {
    const { octokit, calls } = createOctokit();
    const logs: Array<[string, string]> = [];
    const result = await shipPhase({
      issue: 23,
      repo: 'on-par/software-factory',
      worktree: '/repo-factory-23',
      branch: BRANCH,
      octokit: octokit as any,
      watchCI: false,
      log: (type, msg) => logs.push([type, msg]),
      run,
      recordedRemoteSha: RECORDED,
    });
    return { result, calls, logs };
  }

  it('remote unchanged → leased push, verified, PR created', async () => {
    const state = { commands: [] as string[], pushed: false };
    const { result, calls, logs } = await ship(staleRun(at(RECORDED), state));

    expect(result).toEqual({ ok: true, prNumber: 123 });
    expect(state.commands).toContain(`git push '--force-with-lease=${BRANCH}:${RECORDED}' -u origin '${BRANCH}'`);
    expect(state.commands).not.toContain(`git push -u origin '${BRANCH}'`);
    expect(state.commands.some((c) => /--force(\s|$)/.test(c))).toBe(false);
    expect(logs).toContainEqual([
      'ship',
      `remote head ${STUB_HEAD_SHA} matches local HEAD ${STUB_HEAD_SHA} for ${BRANCH}`,
    ]);
    expect(calls).toContainEqual(['pulls.create', expect.anything()]);
  });

  it('remote moved → fails closed naming both SHAs, nothing pushed', async () => {
    const moved = 'c'.repeat(40);
    const state = { commands: [] as string[], pushed: false };
    const { result, calls, logs } = await ship(staleRun(at(moved), state));

    expect(result.ok).toBe(false);
    expect(result.reason).toContain(RECORDED);
    expect(result.reason).toContain(moved);
    expect(state.commands.some((c) => c.startsWith('git push'))).toBe(false);
    expect(calls).not.toContainEqual(['pulls.create', expect.anything()]);
    expect(logs.map(([type]) => type)).not.toContain('ready');
    expect(logs.some(([type, msg]) => type === 'ship' && msg.includes(RECORDED) && msg.includes(moved))).toBe(true);
  });

  it('ls-remote throws → fails closed, nothing pushed', async () => {
    const state = { commands: [] as string[], pushed: false };
    const { result, calls } = await ship(staleRun(new Error('network down'), state));

    expect(result.ok).toBe(false);
    expect(result.reason).toContain(RECORDED);
    expect(result.reason).toContain('network down');
    expect(state.commands.some((c) => c.startsWith('git push'))).toBe(false);
    expect(calls).not.toContainEqual(['pulls.create', expect.anything()]);
  });

  it('remote branch gone → plain push', async () => {
    const state = { commands: [] as string[], pushed: false };
    const { result } = await ship(staleRun({ stdout: '' }, state));

    expect(result.ok).toBe(true);
    expect(state.commands).toContain(`git push -u origin '${BRANCH}'`);
    expect(state.commands.some((c) => c.includes('--force'))).toBe(false);
  });

  it('lease rejected → fails closed as non-fast-forward', async () => {
    const state = { commands: [] as string[], pushed: false };
    const err = Object.assign(new Error('push failed'), {
      stderr: `! [rejected] ${BRANCH} -> ${BRANCH} (stale info)`,
    });
    const { result, calls, logs } = await ship(staleRun(at(RECORDED), state, err));

    expect(result.ok).toBe(false);
    expect(result.reason).toContain(RECORDED);
    expect(logs.some(([, msg]) => msg.includes('(non-fast-forward)'))).toBe(true);
    expect(calls).not.toContainEqual(['pulls.create', expect.anything()]);
  });
});
