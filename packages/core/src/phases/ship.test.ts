import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AdrDraft } from '@on-par/contracts';
import { LaneLifecycleEventSchema } from '@on-par/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLifecycleBus } from '../bus/index.js';
import { specPaths } from '../spec/index.js';
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

  it('does not push or open a PR when the worktree has uncommitted changes', async () => {
    const { octokit, calls } = createOctokit();
    const commands: string[] = [];
    const logs: Array<[string, string]> = [];
    const run = async (command: string) => {
      commands.push(command);
      if (command === 'git status --porcelain') return { stdout: ' M packages/core/src/phases/ship.ts\n' };
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

    expect(result).toEqual({ ok: false });
    expect(commands).toEqual([
      'git fetch origin main',
      'git status --porcelain',
      'git rev-list --count origin/main..HEAD',
      'git diff --quiet origin/main..HEAD',
    ]);
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

      expect(result).toEqual({ ok: true, prNumber: 123 });
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
    // A 'ship'-typed event fires first so a denial doesn't misreport the TUI's failed phase as CHECK/BUILD.
    expect(logs[0]).toEqual(['ship', 'Starting ship phase for ship-it/23-self-heal']);
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

describe('ADR writer (#482)', () => {
  const tempDirs = new Set<string>();
  afterEach(async () => {
    await Promise.all([...tempDirs].map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.clear();
  });

  const goodDraft: AdrDraft = {
    title: 'Record ADR drafts during PLAN',
    context: 'Decisions made during PLAN evaporate into spec prose.',
    decision: 'SHIP materializes drafts as Accepted ADRs.',
    consequences: 'Future PLAN runs can read prior decisions back.',
    status: 'proposed',
    references: [],
  };

  const README_WITH_TABLE = `# Architecture Decision Records

## Index

| Number                 | Title           | Status   |
| ----------------------- | ---------------- | -------- |
| [0001](0001-first.md)  | First decision  | Accepted |
`;

  async function makeWorktree(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'ship-adr-test-'));
    tempDirs.add(dir);
    await mkdir(join(dir, 'docs', 'adr'), { recursive: true });
    await writeFile(
      join(dir, 'docs', 'adr', '0001-first.md'),
      '# ADR-0001: First decision\n\n- Status: Accepted\n- Date: 2026-01-01\n\n## Context\n\nC.\n\n## Decision\n\nD.\n\n## Consequences\n\nCq.\n',
    );
    await writeFile(join(dir, 'docs', 'adr', 'README.md'), README_WITH_TABLE);
    return dir;
  }

  it('writes docs/adr/0002-*.md, updates the index, and commits it before opening the PR', async () => {
    const worktree = await makeWorktree();
    const specPath = join(worktree, 'issue-482.md');
    await writeFile(specPaths(specPath).adr, JSON.stringify([goodDraft], null, 2));

    const { octokit, calls } = createOctokit();
    const commands: string[] = [];
    const logs: Array<[string, string]> = [];
    const run = async (command: string, options?: { cwd?: string }) => {
      commands.push(command);
      void options;
      const remote = remoteHeadStub(command);
      if (remote) return remote;
      if (command === 'git status --porcelain') return { stdout: '' };
      if (command === 'git rev-list --count origin/main..HEAD') return { stdout: '1\n' };
      if (command === 'git diff --quiet origin/main..HEAD') throw new Error('trees differ');
      if (command === 'git diff --stat origin/main...HEAD') return { stdout: ' ship.ts | 12 ++++++++++++\n' };
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
      today: '2026-07-25',
    });

    expect(result.ok).toBe(true);
    void calls;

    const written = await readFile(join(worktree, 'docs', 'adr', '0002-record-adr-drafts-during-plan.md'), 'utf-8');
    expect(written).toContain('# ADR-0002:');
    expect(written).toContain('- Status: Accepted');
    expect(written).toContain('- Date: 2026-07-25');

    const index = await readFile(join(worktree, 'docs', 'adr', 'README.md'), 'utf-8');
    expect(index).toContain('[0002](0002-record-adr-drafts-during-plan.md)');

    const addIdx = commands.findIndex((c) => c.startsWith('git add'));
    const commitIdx = commands.findIndex((c) => c.startsWith('git commit'));
    expect(addIdx).toBeGreaterThanOrEqual(0);
    expect(commitIdx).toBeGreaterThan(addIdx);
    expect(commands[addIdx]).toContain('docs/adr/0002-record-adr-drafts-during-plan.md');
    expect(commands[addIdx]).toContain('docs/adr/README.md');
    expect(commands[commitIdx]).toContain('docs(adr): record ADR-0002 Record ADR drafts during PLAN (#482)');
    expect(logs.some((l) => l[0] === 'adr_written')).toBe(true);
  });

  it('pushes the ADR commit to an already-open PR', async () => {
    const worktree = await makeWorktree();
    const specPath = join(worktree, 'issue-482.md');
    await writeFile(specPaths(specPath).adr, JSON.stringify([goodDraft], null, 2));

    const { octokit } = createOctokit();
    (octokit.rest.pulls.list as any) = async () => {
      return { data: [{ number: 555 }] };
    };
    const commands: string[] = [];
    const run = async (command: string) => {
      commands.push(command);
      const remote = remoteHeadStub(command);
      if (remote) return remote;
      return { stdout: '' };
    };

    const result = await shipPhase({
      issue: 482,
      repo: 'on-par/software-factory',
      worktree,
      branch: 'ship-it/482-adr-writer',
      octokit: octokit as any,
      watchCI: false,
      log: () => {},
      run,
      specPath,
      today: '2026-07-25',
    });

    expect(result).toEqual({ ok: true, prNumber: 555 });
    expect(commands).toContainEqual("git push -u origin 'ship-it/482-adr-writer'");
  });

  it('is a byte-identical no-op with no <spec>.adr.json — no git add/commit, no adr_* logs', async () => {
    const worktree = await makeWorktree();
    const specPath = join(worktree, 'issue-482.md');

    const { octokit } = createOctokit();
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

    expect(result.ok).toBe(true);
    expect(commands.some((c) => c.startsWith('git add'))).toBe(false);
    expect(commands.some((c) => c.startsWith('git commit'))).toBe(false);
    expect(logs.some((l) => l[0].startsWith('adr_'))).toBe(false);
  });

  it('logs adr_commit_skipped and still ships when git commit rejects, without the leftover ADR files aborting recovery', async () => {
    const worktree = await makeWorktree();
    const specPath = join(worktree, 'issue-482.md');
    await writeFile(specPaths(specPath).adr, JSON.stringify([goodDraft], null, 2));

    const { octokit } = createOctokit();
    const logs: Array<[string, string]> = [];
    const commands: string[] = [];
    const run = async (command: string) => {
      commands.push(command);
      const remote = remoteHeadStub(command);
      if (remote) return remote;
      if (command.startsWith('git commit')) throw new Error('nothing to commit');
      // Bare status looks dirty because of the leftover staged ADR files — proves that
      // without path-exclusion this scenario would wrongly abort the self-heal recovery.
      if (command === 'git status --porcelain') {
        return { stdout: ' M docs/adr/0002-record-adr-drafts-during-plan.md\n' };
      }
      if (command.startsWith('git status --porcelain -- .')) return { stdout: '' };
      if (command === 'git rev-list --count origin/main..HEAD') return { stdout: '1\n' };
      if (command === 'git diff --quiet origin/main..HEAD') throw new Error('trees differ');
      if (command === 'git diff --stat origin/main...HEAD') return { stdout: ' ship.ts | 12 ++++++++++++\n' };
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
      today: '2026-07-25',
    });

    expect(result.ok).toBe(true);
    expect(logs).toContainEqual(['adr_commit_skipped', expect.stringContaining('docs/adr')]);
    expect(commands.some((c) => c.startsWith('git status --porcelain -- .'))).toBe(true);
  });

  it('reads and logs adr_read_degraded for a real read failure instead of swallowing it', async () => {
    const worktree = await makeWorktree();
    const specPath = join(worktree, 'issue-482.md');
    await writeFile(specPaths(specPath).adr, JSON.stringify([goodDraft], null, 2));
    // A file too large to read degrades with reason 'too-large', which must surface as a log
    // — unlike a missing docs/adr dir (reason 'not-found'), which stays silent.
    await writeFile(join(worktree, 'docs', 'adr', '0002-oversized.md'), 'x'.repeat(2_000_000));

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

    await shipPhase({
      issue: 482,
      repo: 'on-par/software-factory',
      worktree,
      branch: 'ship-it/482-adr-writer',
      octokit: octokit as any,
      watchCI: false,
      log: (type, msg) => logs.push([type, msg]),
      run,
      specPath,
      today: '2026-07-25',
    });

    expect(logs.some((l) => l[0] === 'adr_read_degraded')).toBe(true);
  });

  it('labels the commit message and log with the on-disk padding, not the default width', async () => {
    const worktree = await makeWorktree();
    // A 3-digit convention: replace the 4-digit fixture with a 3-digit one.
    await rm(join(worktree, 'docs', 'adr', '0001-first.md'));
    await writeFile(
      join(worktree, 'docs', 'adr', '001-first.md'),
      '# ADR-001: First decision\n\n- Status: Accepted\n- Date: 2026-01-01\n\n## Context\n\nC.\n\n## Decision\n\nD.\n\n## Consequences\n\nCq.\n',
    );
    const specPath = join(worktree, 'issue-482.md');
    await writeFile(specPaths(specPath).adr, JSON.stringify([goodDraft], null, 2));

    const { octokit } = createOctokit();
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

    await shipPhase({
      issue: 482,
      repo: 'on-par/software-factory',
      worktree,
      branch: 'ship-it/482-adr-writer',
      octokit: octokit as any,
      watchCI: false,
      log: (type, msg) => logs.push([type, msg]),
      run,
      specPath,
      today: '2026-07-25',
    });

    const written = await readFile(join(worktree, 'docs', 'adr', '002-record-adr-drafts-during-plan.md'), 'utf-8');
    expect(written).toContain('# ADR-002:');
    const commitCommand = commands.find((c) => c.startsWith('git commit'));
    expect(commitCommand).toContain('ADR-002');
    expect(commitCommand).not.toContain('ADR-0002');
    expect(logs.find((l) => l[0] === 'adr_written')?.[1]).toContain('ADR-002');
  });
});

describe('ADR push verification (#736)', () => {
  const tempDirs = new Set<string>();
  afterEach(async () => {
    await Promise.all([...tempDirs].map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.clear();
  });

  const goodDraft: AdrDraft = {
    title: 'Record ADR drafts during PLAN',
    context: 'Decisions made during PLAN evaporate into spec prose.',
    decision: 'SHIP materializes drafts as Accepted ADRs.',
    consequences: 'Future PLAN runs can read prior decisions back.',
    status: 'proposed',
    references: [],
  };

  const README_WITH_TABLE = `# Architecture Decision Records

## Index

| Number                 | Title           | Status   |
| ----------------------- | ---------------- | -------- |
| [0001](0001-first.md)  | First decision  | Accepted |
`;

  async function makeWorktree(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'ship-adr-push-test-'));
    tempDirs.add(dir);
    await mkdir(join(dir, 'docs', 'adr'), { recursive: true });
    await writeFile(
      join(dir, 'docs', 'adr', '0001-first.md'),
      '# ADR-0001: First decision\n\n- Status: Accepted\n- Date: 2026-01-01\n\n## Context\n\nC.\n\n## Decision\n\nD.\n\n## Consequences\n\nCq.\n',
    );
    await writeFile(join(dir, 'docs', 'adr', 'README.md'), README_WITH_TABLE);
    return dir;
  }

  async function makeOpenPrOctokit() {
    const { octokit, calls } = createOctokit();
    (octokit.rest.pulls.list as any) = async (args: any) => {
      calls.push(['pulls.list', args]);
      return { data: [{ number: 555 }] };
    };
    return { octokit, calls };
  }

  it('rejected push: non-success, git stderr logged', async () => {
    const worktree = await makeWorktree();
    const specPath = join(worktree, 'issue-482.md');
    await writeFile(specPaths(specPath).adr, JSON.stringify([goodDraft], null, 2));

    const { octokit } = await makeOpenPrOctokit();
    const logs: Array<[string, string]> = [];
    const run = async (command: string) => {
      if (command.startsWith('git push')) {
        throw Object.assign(new Error('Command failed: git push'), {
          stderr:
            ' ! [rejected]        ship-it/482-adr-writer -> ship-it/482-adr-writer (non-fast-forward)\nerror: failed to push some refs to origin\n',
        });
      }
      const remote = remoteHeadStub(command);
      if (remote) return remote;
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
      today: '2026-07-25',
    });

    expect(result).toEqual({ ok: false, prNumber: 555, adrPushFailed: true });
    const failLog = logs.find((l) => l[0] === 'adr_push_failed');
    expect(failLog).toBeDefined();
    expect(failLog?.[1]).toMatch(/^pushing the ADR commit for PR #555 failed \(non-fast-forward\): ! \[rejected\]/);
    expect(failLog?.[1]).toContain('failed to push some refs');
    expect(failLog?.[1]).toMatch(/— aborting the ship$/);
    expect(failLog?.[1]).not.toContain('\n');
  });

  it('rejected push: no evidence pack, no ready flip, no ready event', async () => {
    const worktree = await makeWorktree();
    const specPath = join(worktree, 'issue-482.md');
    await writeFile(specPaths(specPath).adr, JSON.stringify([goodDraft], null, 2));

    const { octokit, calls } = await makeOpenPrOctokit();
    const logs: Array<[string, string]> = [];
    const run = async (command: string) => {
      if (command.startsWith('git push')) {
        throw Object.assign(new Error('Command failed: git push'), {
          stderr: ' ! [rejected] (non-fast-forward)\nerror: failed to push some refs\n',
        });
      }
      const remote = remoteHeadStub(command);
      if (remote) return remote;
      return { stdout: '' };
    };

    await shipPhase({
      issue: 482,
      repo: 'on-par/software-factory',
      worktree,
      branch: 'ship-it/482-adr-writer',
      octokit: octokit as any,
      watchCI: false,
      log: (type, msg) => logs.push([type, msg]),
      run,
      specPath,
      today: '2026-07-25',
    });

    expect(calls.some((call) => call[0] === 'issues.createComment')).toBe(false);
    expect(calls.some((call) => call[0] === 'graphql')).toBe(false);
    expect(logs.some((l) => l[0] === 'ready')).toBe(false);
    expect(logs.some((l) => l[0] === 'evidence')).toBe(false);
  });

  it('network-classified rejection', async () => {
    const worktree = await makeWorktree();
    const specPath = join(worktree, 'issue-482.md');
    await writeFile(specPaths(specPath).adr, JSON.stringify([goodDraft], null, 2));

    const { octokit } = await makeOpenPrOctokit();
    const logs: Array<[string, string]> = [];
    const run = async (command: string) => {
      if (command.startsWith('git push')) {
        throw Object.assign(new Error('Command failed: git push'), {
          stderr:
            "fatal: unable to access 'https://github.com/on-par/software-factory.git/': Could not resolve host: github.com\n",
        });
      }
      const remote = remoteHeadStub(command);
      if (remote) return remote;
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
      today: '2026-07-25',
    });

    expect(result).toEqual({ ok: false, prNumber: 555, adrPushFailed: true });
    const failLog = logs.find((l) => l[0] === 'adr_push_failed');
    expect(failLog?.[1]).toContain('(network)');
    expect(failLog?.[1]).toContain('Could not resolve host');
  });

  it('zero-exit push, remote head mismatch: non-success', async () => {
    const worktree = await makeWorktree();
    const specPath = join(worktree, 'issue-482.md');
    await writeFile(specPaths(specPath).adr, JSON.stringify([goodDraft], null, 2));

    const { octokit } = await makeOpenPrOctokit();
    const logs: Array<[string, string]> = [];
    const mismatchedSha = 'f'.repeat(40);
    const run = async (command: string) => {
      const remote = remoteHeadStub(command, mismatchedSha);
      if (remote) return remote;
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
      today: '2026-07-25',
    });

    expect(result).toEqual({ ok: false, prNumber: 555, adrPushFailed: true });
    const failLog = logs.find((l) => l[0] === 'adr_push_failed');
    expect(failLog?.[1]).toMatch(
      /^remote head f{40} does not match local HEAD [0-9a-f]{40} after the ADR push for ship-it\/482-adr-writer — aborting the ship$/,
    );
  });

  it('zero-exit push, remote head unreadable: non-success', async () => {
    const worktree = await makeWorktree();
    const specPath = join(worktree, 'issue-482.md');
    await writeFile(specPaths(specPath).adr, JSON.stringify([goodDraft], null, 2));

    const { octokit } = await makeOpenPrOctokit();
    const logs: Array<[string, string]> = [];
    const run = async (command: string) => {
      if (command.startsWith('git ls-remote')) {
        throw Object.assign(new Error('boom'), { stderr: 'fatal: could not read Username' });
      }
      const remote = remoteHeadStub(command);
      if (remote) return remote;
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
      today: '2026-07-25',
    });

    expect(result).toEqual({ ok: false, prNumber: 555, adrPushFailed: true });
    const failLog = logs.find((l) => l[0] === 'adr_push_failed');
    expect(failLog?.[1]).toContain('could not verify the remote head after the ADR push');
    expect(failLog?.[1]).toContain('fatal: could not read Username');
  });

  it('verified push: ship succeeds and logs the match line', async () => {
    const worktree = await makeWorktree();
    const specPath = join(worktree, 'issue-482.md');
    await writeFile(specPaths(specPath).adr, JSON.stringify([goodDraft], null, 2));

    const { octokit } = await makeOpenPrOctokit();
    const logs: Array<[string, string]> = [];
    const run = async (command: string) => {
      const remote = remoteHeadStub(command);
      if (remote) return remote;
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
      today: '2026-07-25',
    });

    expect(result).toEqual({ ok: true, prNumber: 555 });
    expect(logs).toContainEqual([
      'ship',
      `remote head ${STUB_HEAD_SHA} matches local HEAD ${STUB_HEAD_SHA} after the ADR push for ship-it/482-adr-writer`,
    ]);
    expect(logs.some((l) => l[0] === 'ready')).toBe(true);
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
