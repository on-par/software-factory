import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { ModelDiagnosis } from '@on-par/factory-core';
import {
  main,
  PREREQUISITES_TEXT,
  isPrMerged,
  findOpenPRNumber,
  findOpenPRForIssue,
  squashMergeAndDelete,
  getPullRequestLandState,
  markPullRequestReady,
  landOpenPullRequest,
  waitForMerge,
  LandConflictError,
  LandFailureError,
  LaneParkError,
  parkReasonFor,
  runLane,
  resolveUsageKnobs,
  superviseLoop,
  triageProposalMessage,
  formatDoctorReport,
  hasReachableWorker,
  scaffoldConstitution,
  initConstitution,
  assertValidProduct,
  ConstitutionExistsError,
  InvalidProductNameError,
} from './cli/index.js';

describe('cli', () => {
  it('exports the main entrypoint', () => {
    expect(typeof main).toBe('function');
  });

  it('formats the triage proposal message with an accept hint for non-empty content', () => {
    const message = triageProposalMessage('lane-a 1\nlane-b 2\n', '/repo/.factory/queue.proposed', '/repo/.factory/queue');
    expect(message).toContain('lane-a 1\nlane-b 2');
    expect(message).toContain('factory triage accept');
  });

  it('returns null for empty or whitespace-only triage proposals', () => {
    expect(triageProposalMessage('', '/repo/.factory/queue.proposed', '/repo/.factory/queue')).toBeNull();
    expect(triageProposalMessage('   \n  ', '/repo/.factory/queue.proposed', '/repo/.factory/queue')).toBeNull();
  });

  it('resolves usage knobs from defaults', () => {
    expect(resolveUsageKnobs({})).toEqual({
      cap: 227,
      stopAt: 0.75,
      resumeAt: 0.65,
      pollMs: 180_000,
      watch: true,
    });
  });

  it('resolves usage knobs from env overrides', () => {
    expect(resolveUsageKnobs({
      FACTORY_USAGE_CAP: '100',
      FACTORY_STOP_AT: '0.5',
      FACTORY_RESUME_AT: '0.4',
      FACTORY_USAGE_POLL: '60',
      FACTORY_USAGE_WATCH: '0',
    })).toEqual({
      cap: 100,
      stopAt: 0.5,
      resumeAt: 0.4,
      pollMs: 60_000,
      watch: false,
    });
  });

  it('rejects invalid usage knob values with env var names', () => {
    expect(() => resolveUsageKnobs({ FACTORY_USAGE_CAP: '-5' })).toThrow(/FACTORY_USAGE_CAP/);
    expect(() => resolveUsageKnobs({ FACTORY_STOP_AT: '1.5' })).toThrow(/FACTORY_STOP_AT/);
    expect(() => resolveUsageKnobs({ FACTORY_RESUME_AT: '1.5' })).toThrow(/FACTORY_RESUME_AT/);
    expect(() => resolveUsageKnobs({ FACTORY_USAGE_POLL: 'abc' })).toThrow(/FACTORY_USAGE_POLL/);
  });

  it('waits for the resume gate, runs the queue, and loops again while STOP is present', async () => {
    const calls: any[] = [];
    const spends = [0.9, 0.9, 0.5, 0.5];
    const pathExistsResults = [true, false];
    let runQueueCalls = 0;

    await superviseLoop({
      cap: 1,
      resumeAt: 0.65,
      pollMs: 1000,
      stopFile: '/repo/.factory/STOP',
      eventsFile: '/repo/.factory/events.ndjson',
      now: false,
      estimateSpend: () => spends.shift()!,
      pathExists: () => pathExistsResults.shift()!,
      clearStop: path => calls.push(['clearStop', path]),
      sleep: async () => { calls.push(['sleep']); },
      emitEvent: (_eventsFile: string, type: string, issue: string | number, msg: string) => { calls.push(['event', type, issue, msg]); },
      writeLine: line => calls.push(['writeLine', line]),
      runQueue: async () => {
        runQueueCalls++;
        calls.push(['runQueue']);
      },
    });

    expect(runQueueCalls).toBe(2);
    const firstRunQueueIdx = calls.findIndex(c => c[0] === 'runQueue');
    const firstSleepIdx = calls.findIndex(c => c[0] === 'sleep');
    expect(firstSleepIdx).toBeGreaterThanOrEqual(0);
    expect(firstSleepIdx).toBeLessThan(firstRunQueueIdx);

    const clearStopCalls = calls.filter(c => c[0] === 'clearStop');
    expect(clearStopCalls).toHaveLength(2);

    const events = calls.filter(c => c[0] === 'event');
    expect(events.filter(e => e[1] === 'resumed')).toHaveLength(2);
    expect(events.filter(e => e[1] === 'supervisor-done')).toHaveLength(1);
    expect(events[events.length - 1][1]).toBe('supervisor-done');
  });

  it('exits after one cycle when the queue drains without STOP present', async () => {
    const calls: any[] = [];

    await superviseLoop({
      cap: 1,
      resumeAt: 0.65,
      pollMs: 1000,
      stopFile: '/repo/.factory/STOP',
      eventsFile: '/repo/.factory/events.ndjson',
      now: true,
      estimateSpend: () => 0.1,
      pathExists: () => false,
      clearStop: () => {},
      sleep: async () => { calls.push(['sleep']); },
      emitEvent: (_eventsFile: string, type: string) => { calls.push(['event', type]); },
      runQueue: async () => { calls.push(['runQueue']); },
    });

    expect(calls.filter(c => c[0] === 'runQueue')).toHaveLength(1);
    expect(calls.filter(c => c[0] === 'sleep')).toHaveLength(0);
    expect(calls.filter(c => c[0] === 'event' && c[1] === 'supervisor-done')).toHaveLength(1);
  });

  it('skips the initial headroom wait when --now is set', async () => {
    const calls: any[] = [];

    await superviseLoop({
      cap: 1,
      resumeAt: 0.65,
      pollMs: 1000,
      stopFile: '/repo/.factory/STOP',
      eventsFile: '/repo/.factory/events.ndjson',
      now: true,
      estimateSpend: () => 0.9,
      pathExists: () => false,
      clearStop: () => {},
      sleep: async () => { calls.push(['sleep']); },
      emitEvent: () => {},
      runQueue: async () => { calls.push(['runQueue']); },
    });

    expect(calls).toEqual([['runQueue']]);
  });

  it('re-checks the resume gate after each wait', async () => {
    const calls: any[] = [];
    const spends = [0.9, 0.9, 0.5];

    await superviseLoop({
      cap: 1,
      resumeAt: 0.65,
      pollMs: 1000,
      stopFile: '/repo/.factory/STOP',
      eventsFile: '/repo/.factory/events.ndjson',
      now: false,
      estimateSpend: () => spends.shift()!,
      pathExists: () => false,
      clearStop: () => {},
      sleep: async () => {},
      emitEvent: () => {},
      writeLine: line => calls.push(line),
      runQueue: async () => {},
    });

    expect(calls).toHaveLength(2);
  });

  it('skips the resume gate entirely when watch is false, even at a high estimated spend', async () => {
    const calls: any[] = [];

    await superviseLoop({
      cap: 1,
      resumeAt: 0.65,
      pollMs: 1000,
      watch: false,
      stopFile: '/repo/.factory/STOP',
      eventsFile: '/repo/.factory/events.ndjson',
      now: false,
      estimateSpend: () => 1.6,
      pathExists: () => false,
      clearStop: () => {},
      sleep: async () => { calls.push(['sleep']); },
      emitEvent: () => {},
      writeLine: line => calls.push(['writeLine', line]),
      runQueue: async () => { calls.push(['runQueue']); },
    });

    expect(calls.filter(c => c[0] === 'sleep')).toHaveLength(0);
    expect(calls.filter(c => c[0] === 'runQueue')).toHaveLength(1);
  });

  it('detects a merge by head branch even when it is outside the recent-closed window', async () => {
    const octokit: any = {
      rest: { pulls: { list: async ({ head }: any) =>
        head === 'on-par:ship-it/22-x'
          ? { data: [{ merged_at: '2026-01-01T00:00:00Z' }] }
          : { data: [] } } },
    };
    expect(await isPrMerged(octokit, 'on-par', 'software-factory', 'ship-it/22-x')).toBe(true);
  });

  it('returns false when the head branch has no merged PR', async () => {
    const octokit: any = { rest: { pulls: { list: async () => ({ data: [{ merged_at: null }] }) } } };
    expect(await isPrMerged(octokit, 'on-par', 'software-factory', 'ship-it/22-x')).toBe(false);
  });

  it('finds an open PR number for the matching head branch', async () => {
    const octokit: any = {
      rest: { pulls: { list: async ({ head }: any) =>
        head === 'on-par:ship-it/19-land'
          ? { data: [{ number: 123 }] }
          : { data: [] } } },
    };

    expect(await findOpenPRNumber(octokit, 'on-par', 'software-factory', 'ship-it/19-land')).toBe(123);
  });

  it('returns undefined when no open PR exists for the head branch', async () => {
    const octokit: any = {
      rest: { pulls: { list: async () => ({ data: [] }) } },
    };

    expect(await findOpenPRNumber(octokit, 'on-par', 'software-factory', 'ship-it/19-land')).toBeUndefined();
  });

  it('falls back to matching the open PR that references the issue in its body', async () => {
    const octokit: any = {
      rest: {
        pulls: {
          list: async () => ({
            data: [
              { number: 1, body: 'Closes #7', head: { ref: 'ship-it/1-unrelated' } },
              { number: 42, body: 'Fixes some things.\n\nCloses #19', head: { ref: 'ship-it/19-renamed-title' } },
            ],
          }),
        },
      },
    };

    expect(await findOpenPRForIssue(octokit, 'on-par', 'software-factory', 19)).toEqual({
      number: 42,
      branch: 'ship-it/19-renamed-title',
    });
  });

  it('returns undefined from the issue-body fallback when no open PR references the issue', async () => {
    const octokit: any = {
      rest: { pulls: { list: async () => ({ data: [{ number: 1, body: 'Closes #7', head: { ref: 'x' } }] }) } },
    };

    expect(await findOpenPRForIssue(octokit, 'on-par', 'software-factory', 19)).toBeUndefined();
  });

  it('paginates the issue-body fallback to find a match beyond the first page', async () => {
    const calledPages: number[] = [];
    const octokit: any = {
      rest: {
        pulls: {
          list: async ({ page }: any) => {
            calledPages.push(page);
            if (page === 1) {
              return {
                data: Array.from({ length: 100 }, (_, i) => ({
                  number: i + 1,
                  body: 'Closes #7',
                  head: { ref: `ship-it/${i + 1}-unrelated` },
                })),
              };
            }
            if (page === 2) {
              return {
                data: Array.from({ length: 30 }, (_, i) => {
                  if (i === 19) {
                    return { number: 999, body: 'Closes #19', head: { ref: 'ship-it/19-renamed-title' } };
                  }
                  return { number: 100 + i + 1, body: 'Closes #7', head: { ref: `ship-it/${100 + i + 1}-unrelated` } };
                }),
              };
            }
            return { data: [] };
          },
        },
      },
    };

    expect(await findOpenPRForIssue(octokit, 'on-par', 'software-factory', 19)).toEqual({
      number: 999,
      branch: 'ship-it/19-renamed-title',
    });
    expect(calledPages).toEqual([1, 2]);
  });

  it('paginates through every page and returns undefined when no page matches', async () => {
    const calledPages: number[] = [];
    const octokit: any = {
      rest: {
        pulls: {
          list: async ({ page }: any) => {
            calledPages.push(page);
            if (page === 1 || page === 2) {
              return {
                data: Array.from({ length: 100 }, (_, i) => ({
                  number: (page - 1) * 100 + i + 1,
                  body: 'Closes #7',
                  head: { ref: `ship-it/${(page - 1) * 100 + i + 1}-unrelated` },
                })),
              };
            }
            return { data: [] };
          },
        },
      },
    };

    expect(await findOpenPRForIssue(octokit, 'on-par', 'software-factory', 19)).toBeUndefined();
    expect(calledPages).toEqual([1, 2, 3]);
  });

  it('self-merges a ready PR when FACTORY_MERGE is enabled', async () => {
    const calls: any[] = [];
    const octokit: any = {};
    const paths: any = { events: '/repo/.factory/events.ndjson', stop: '/repo/.factory/STOP' };
    const originalFactoryMerge = process.env.FACTORY_MERGE;

    try {
      process.env.FACTORY_MERGE = '1';
      await waitForMerge(21, 'ship-it/21-self-merge', '/repo', 'on-par/software-factory', paths, {
        createOctokit: () => octokit,
        pathExists: () => false,
        checkMerged: async (...args: any[]) => {
          calls.push(['checkMerged', args]);
          return false;
        },
        land: async (...args: any[]) => {
          calls.push(['land', args]);
          return { branch: 'ship-it/21-self-merge', prNumber: 321 };
        },
        sleep: async () => {
          calls.push(['sleep']);
        },
      });
    } finally {
      if (originalFactoryMerge === undefined) {
        delete process.env.FACTORY_MERGE;
      } else {
        process.env.FACTORY_MERGE = originalFactoryMerge;
      }
    }

    expect(calls).toEqual([
      ['checkMerged', [octokit, 'on-par', 'software-factory', 'ship-it/21-self-merge']],
      ['land', [21, '/repo', 'on-par/software-factory', paths, octokit, false]],
    ]);
  });

  it('defaults to review mode and polls without merging', async () => {
    const calls: any[] = [];
    const paths: any = { events: '/repo/.factory/events.ndjson', stop: '/repo/.factory/STOP' };
    const originalFactoryMerge = process.env.FACTORY_MERGE;
    let stopped = false;

    try {
      delete process.env.FACTORY_MERGE;
      await waitForMerge(21, 'ship-it/21-self-merge', '/repo', 'on-par/software-factory', paths, {
        createOctokit: () => ({} as any),
        pathExists: () => stopped,
        checkMerged: async () => {
          calls.push(['checkMerged']);
          return false;
        },
        land: async () => {
          throw new Error('land should not be called');
        },
        writeLine: line => calls.push(['writeLine', line]),
        sleep: async ms => {
          calls.push(['sleep', ms]);
          stopped = true;
        },
      });
    } finally {
      if (originalFactoryMerge === undefined) {
        delete process.env.FACTORY_MERGE;
      } else {
        process.env.FACTORY_MERGE = originalFactoryMerge;
      }
    }

    expect(calls).toEqual([
      ['checkMerged'],
      ['writeLine', '[factory] #21 awaiting human merge (poll 120s)'],
      ['sleep', 120_000],
    ]);
  });

  it('squash-merges a PR and deletes its branch', async () => {
    const calls: any[] = [];
    const octokit: any = {
      rest: {
        pulls: {
          merge: async (args: any) => {
            calls.push(['merge', args]);
          },
        },
        git: {
          deleteRef: async (args: any) => {
            calls.push(['deleteRef', args]);
          },
        },
      },
    };

    // cmdLand reuses withGitLock for merge serialization; lock behavior is covered in core.
    await squashMergeAndDelete(octokit, 'on-par', 'software-factory', 'ship-it/19-land', 123);

    expect(calls).toEqual([
      ['merge', { owner: 'on-par', repo: 'software-factory', pull_number: 123, merge_method: 'squash' }],
      ['deleteRef', { owner: 'on-par', repo: 'software-factory', ref: 'heads/ship-it/19-land' }],
    ]);
  });

  it('does not throw when deleting the merged branch fails', async () => {
    const octokit: any = {
      rest: {
        pulls: { merge: async () => {} },
        git: { deleteRef: async () => { throw new Error('not found'); } },
      },
    };

    await expect(
      squashMergeAndDelete(octokit, 'on-par', 'software-factory', 'ship-it/19-land', 123),
    ).resolves.toBeUndefined();
  });

  it('reads the pull request land state fields', async () => {
    const calls: any[] = [];
    const octokit: any = {
      graphql: async (query: string, vars: any) => {
        calls.push({ query, vars });
        return { repository: { pullRequest: { id: 'PR_1', isDraft: false, mergeStateStatus: 'DIRTY' } } };
      },
    };

    await expect(
      getPullRequestLandState(octokit, 'on-par', 'software-factory', 123),
    ).resolves.toEqual({ id: 'PR_1', isDraft: false, mergeStateStatus: 'DIRTY' });
    expect(calls[0].vars).toEqual({ owner: 'on-par', repo: 'software-factory', number: 123 });
    expect(calls[0].query).toContain('isDraft');
    expect(calls[0].query).toContain('mergeStateStatus');
  });

  it('marks a pull request ready for review by node id', async () => {
    const calls: any[] = [];
    const octokit: any = {
      graphql: async (query: string, vars: any) => {
        calls.push({ query, vars });
      },
    };

    await markPullRequestReady(octokit, 'PR_1');

    expect(calls[0].vars).toEqual({ id: 'PR_1' });
    expect(calls[0].query).toContain('markPullRequestReadyForReview');
  });

  it('rebases and force-pushes a DIRTY PR before squash-merging it', async () => {
    const calls: any[] = [];
    const octokit: any = {
      graphql: async () => ({ repository: { pullRequest: { id: 'PR_1', isDraft: false, mergeStateStatus: 'DIRTY' } } }),
      rest: {
        pulls: {
          merge: async (args: any) => {
            calls.push(['merge', args]);
          },
        },
        git: {
          deleteRef: async (args: any) => {
            calls.push(['deleteRef', args]);
          },
        },
        checks: {
          listForRef: async () => ({ data: { check_runs: [{ status: 'completed', conclusion: 'success' }] } }),
        },
      },
    };
    const run = async (command: string, options: any) => {
      calls.push(['run', command, options]);
    };

    await landOpenPullRequest({
      octokit,
      owner: 'on-par',
      repoName: 'software-factory',
      ghRepo: 'on-par/software-factory',
      repoRoot: '/repo',
      issue: 20,
      branch: 'ship-it/20-dirty',
      worktree: '/repo-factory-20',
      prNumber: 123,
      log: (type, msg) => calls.push(['log', type, msg]),
      run,
      pathExists: () => true,
      sleep: async () => { throw new Error('sleep should not be called'); },
    });

    expect(calls).toEqual([
      ['run', 'git rebase origin/main', { cwd: '/repo-factory-20' }],
      ['run', "git push --force-with-lease origin 'ship-it/20-dirty'", { cwd: '/repo-factory-20' }],
      ['merge', { owner: 'on-par', repo: 'software-factory', pull_number: 123, merge_method: 'squash' }],
      ['deleteRef', { owner: 'on-par', repo: 'software-factory', ref: 'heads/ship-it/20-dirty' }],
    ]);
  });

  it('aborts the rebase, logs conflict with the branch, and skips merge when rebase fails', async () => {
    const calls: any[] = [];
    const octokit: any = {
      graphql: async () => ({ repository: { pullRequest: { id: 'PR_1', isDraft: false, mergeStateStatus: 'DIRTY' } } }),
      rest: {
        pulls: {
          merge: async (args: any) => {
            calls.push(['merge', args]);
          },
        },
        git: { deleteRef: async () => {} },
        checks: {
          listForRef: async () => ({ data: { check_runs: [{ status: 'completed', conclusion: 'success' }] } }),
        },
      },
    };
    const run = async (command: string, options: any) => {
      calls.push(['run', command, options]);
      if (command === 'git rebase origin/main') throw new Error('conflict');
    };

    await expect(
      landOpenPullRequest({
        octokit,
        owner: 'on-par',
        repoName: 'software-factory',
        ghRepo: 'on-par/software-factory',
        repoRoot: '/repo',
        issue: 20,
        branch: 'ship-it/20-dirty',
        worktree: '/repo-factory-20',
        prNumber: 123,
        log: (type, msg) => calls.push(['log', type, msg]),
        run,
        pathExists: () => true,
        sleep: async () => { throw new Error('sleep should not be called'); },
      }),
    ).rejects.toBeInstanceOf(LandConflictError);

    expect(calls).toEqual([
      ['run', 'git rebase origin/main', { cwd: '/repo-factory-20' }],
      ['run', 'git rebase --abort', { cwd: '/repo-factory-20' }],
      ['log', 'conflict', 'rebase conflict on ship-it/20-dirty — parked'],
    ]);
  });

  it('logs conflict and skips merge when a DIRTY PR worktree is gone', async () => {
    const calls: any[] = [];
    const octokit: any = {
      graphql: async () => ({ repository: { pullRequest: { id: 'PR_1', isDraft: false, mergeStateStatus: 'DIRTY' } } }),
      rest: {
        pulls: {
          merge: async (args: any) => {
            calls.push(['merge', args]);
          },
        },
        git: { deleteRef: async () => {} },
        checks: {
          listForRef: async () => ({ data: { check_runs: [{ status: 'completed', conclusion: 'success' }] } }),
        },
      },
    };
    const run = async (command: string, options: any) => {
      calls.push(['run', command, options]);
    };

    await expect(
      landOpenPullRequest({
        octokit,
        owner: 'on-par',
        repoName: 'software-factory',
        ghRepo: 'on-par/software-factory',
        repoRoot: '/repo',
        issue: 20,
        branch: 'ship-it/20-dirty',
        worktree: '/repo-factory-20',
        prNumber: 123,
        log: (type, msg) => calls.push(['log', type, msg]),
        run,
        pathExists: () => false,
        sleep: async () => { throw new Error('sleep should not be called'); },
      }),
    ).rejects.toBeInstanceOf(LandConflictError);

    expect(calls).toEqual([
      ['log', 'conflict', 'PR #123 DIRTY on ship-it/20-dirty and worktree gone'],
    ]);
  });

  it('re-issues the ready flip when the PR is still a draft, then merges', async () => {
    const calls: any[] = [];
    const sleeps: number[] = [];
    const octokit: any = {
      graphql: async (query: string, vars: any) => {
        if (query.trimStart().startsWith('query')) {
          calls.push(['query', vars]);
          return { repository: { pullRequest: { id: 'PR_1', isDraft: true, mergeStateStatus: 'BLOCKED' } } };
        }
        if (query.includes('markPullRequestReadyForReview')) {
          calls.push(['mutation', vars]);
          return { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } };
        }
        throw new Error('unexpected graphql');
      },
      rest: {
        pulls: {
          merge: async (args: any) => {
            calls.push(['merge', args]);
          },
        },
        git: { deleteRef: async (args: any) => calls.push(['deleteRef', args]) },
        checks: {
          listForRef: async () => ({ data: { check_runs: [{ status: 'completed', conclusion: 'success' }] } }),
        },
      },
    };

    await landOpenPullRequest({
      octokit,
      owner: 'on-par',
      repoName: 'software-factory',
      ghRepo: 'on-par/software-factory',
      repoRoot: '/repo',
      issue: 20,
      branch: 'ship-it/20-draft',
      worktree: '/repo-factory-20',
      prNumber: 123,
      log: (type, msg) => calls.push(['log', type, msg]),
      run: async () => {},
      pathExists: () => true,
      sleep: async ms => { sleeps.push(ms); },
    });

    expect(calls.findIndex(c => c[0] === 'mutation')).toBeLessThan(calls.findIndex(c => c[0] === 'merge'));
    expect(calls).toContainEqual(['mutation', { id: 'PR_1' }]);
    expect(sleeps).toEqual([]);
  });

  it('retries the merge with backoff while the PR is still a draft', async () => {
    const sleeps: number[] = [];
    const states = [
      { id: 'PR_1', isDraft: true, mergeStateStatus: 'BLOCKED' },
      { id: 'PR_1', isDraft: false, mergeStateStatus: 'CLEAN' },
    ];
    let mergeCalls = 0;
    const octokit: any = {
      graphql: async (query: string, vars: any) => {
        if (query.trimStart().startsWith('query')) {
          return { repository: { pullRequest: states.shift() } };
        }
        expect(query).toContain('markPullRequestReadyForReview');
        expect(vars).toEqual({ id: 'PR_1' });
        return { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } };
      },
      rest: {
        pulls: {
          merge: async () => {
            mergeCalls++;
            if (mergeCalls === 1) throw new Error('Pull Request is still a draft');
          },
        },
        git: { deleteRef: async () => {} },
        checks: {
          listForRef: async () => ({ data: { check_runs: [{ status: 'completed', conclusion: 'success' }] } }),
        },
      },
    };

    await landOpenPullRequest({
      octokit,
      owner: 'on-par',
      repoName: 'software-factory',
      ghRepo: 'on-par/software-factory',
      repoRoot: '/repo',
      issue: 20,
      branch: 'ship-it/20-draft',
      worktree: '/repo-factory-20',
      prNumber: 123,
      log: () => {},
      run: async () => {},
      pathExists: () => true,
      sleep: async ms => { sleeps.push(ms); },
    });

    expect(mergeCalls).toBe(2);
    expect(sleeps).toEqual([5000]);
  });

  it('retries while mergeStateStatus is UNKNOWN', async () => {
    const sleeps: number[] = [];
    let mergeCalls = 0;
    let mutationCalls = 0;
    const octokit: any = {
      graphql: async (query: string) => {
        if (query.trimStart().startsWith('query')) {
          return { repository: { pullRequest: { id: 'PR_1', isDraft: false, mergeStateStatus: 'UNKNOWN' } } };
        }
        mutationCalls++;
        return { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } };
      },
      rest: {
        pulls: {
          merge: async () => {
            mergeCalls++;
            if (mergeCalls < 3) throw new Error('Pull Request is not mergeable');
          },
        },
        git: { deleteRef: async () => {} },
        checks: {
          listForRef: async () => ({ data: { check_runs: [{ status: 'completed', conclusion: 'success' }] } }),
        },
      },
    };

    await landOpenPullRequest({
      octokit,
      owner: 'on-par',
      repoName: 'software-factory',
      ghRepo: 'on-par/software-factory',
      repoRoot: '/repo',
      issue: 20,
      branch: 'ship-it/20-unknown',
      worktree: '/repo-factory-20',
      prNumber: 123,
      log: () => {},
      run: async () => {},
      pathExists: () => true,
      sleep: async ms => { sleeps.push(ms); },
    });

    expect(mergeCalls).toBe(3);
    expect(sleeps).toEqual([5000, 10000]);
    expect(mutationCalls).toBe(0);
  });

  it('parks only after retries are exhausted', async () => {
    const sleeps: number[] = [];
    const mergeError = new Error('Pull Request is still a draft');
    let mergeCalls = 0;
    const octokit: any = {
      graphql: async () => ({ repository: { pullRequest: { id: 'PR_1', isDraft: false, mergeStateStatus: 'UNKNOWN' } } }),
      rest: {
        pulls: {
          merge: async () => {
            mergeCalls++;
            throw mergeError;
          },
        },
        git: { deleteRef: async () => {} },
        checks: {
          listForRef: async () => ({ data: { check_runs: [{ status: 'completed', conclusion: 'success' }] } }),
        },
      },
    };

    await expect(
      landOpenPullRequest({
        octokit,
        owner: 'on-par',
        repoName: 'software-factory',
        ghRepo: 'on-par/software-factory',
        repoRoot: '/repo',
        issue: 20,
        branch: 'ship-it/20-retry',
        worktree: '/repo-factory-20',
        prNumber: 123,
        log: () => {},
        run: async () => {},
        pathExists: () => true,
        sleep: async ms => { sleeps.push(ms); },
      }),
    ).rejects.toBe(mergeError);

    expect(mergeCalls).toBe(5);
    expect(sleeps).toEqual([5000, 10000, 20000, 40000]);
  });

  describe('parkReasonFor', () => {
    it('maps a LaneParkError to its own reason', () => {
      expect(parkReasonFor(new LaneParkError('x', 'escalate'))).toBe('escalate');
      expect(parkReasonFor(new LaneParkError('x', 'fail'))).toBe('fail');
    });

    it('maps a LandConflictError to conflict', () => {
      expect(parkReasonFor(new LandConflictError('x'))).toBe('conflict');
    });

    it('maps an error carrying reason: timeout to timeout', () => {
      expect(parkReasonFor(Object.assign(new Error('x'), { reason: 'timeout' }))).toBe('timeout');
    });

    it('defaults a plain Error or LandFailureError to fail', () => {
      expect(parkReasonFor(new Error('x'))).toBe('fail');
      expect(parkReasonFor(new LandFailureError('x', 5))).toBe('fail');
    });
  });

  describe('runLane', () => {
    const paths: any = { events: '/repo/.factory/events.ndjson', stop: '/repo/.factory/STOP' };

    it('parks the lane without re-emitting the terminal event (shipIssue owns it) on an escalate error', async () => {
      const calls: any[] = [];
      await runLane('app', [7, 8], '/repo', 'on-par/software-factory', paths, {
        ship: async (issue) => {
          calls.push(['ship', issue]);
          throw new LaneParkError('plan escalated: needs a human decision', 'escalate');
        },
        waitMerge: async () => { throw new Error('waitMerge should not be called'); },
        pathExists: () => false,
        emitEvent: (_events: string, type: string, issue: string | number, msg: string) => calls.push(['event', type, issue, msg]),
      });

      expect(calls.filter(c => c[0] === 'ship')).toEqual([['ship', 7]]);
      const events = calls.filter(c => c[0] === 'event');
      expect(events).toHaveLength(1);
      expect(events[0][1]).toBe('parked');
      expect(events[0][2]).toBe(7);
      expect(events[0][3]).toContain('(escalate)');
      expect(events.some(e => e[1] === 'escalate')).toBe(false);
      expect(events.some(e => e[1] === 'lane-done')).toBe(false);
    });

    it('parks the lane without re-emitting the terminal event (shipIssue owns it) on a timeout error', async () => {
      const calls: any[] = [];
      await runLane('app', [9], '/repo', 'on-par/software-factory', paths, {
        ship: async () => { throw Object.assign(new Error('router exhausted'), { reason: 'timeout' }); },
        waitMerge: async () => { throw new Error('waitMerge should not be called'); },
        pathExists: () => false,
        emitEvent: (_events: string, type: string, issue: string | number, msg: string) => calls.push(['event', type, issue, msg]),
      });

      const events = calls.filter(c => c[0] === 'event');
      expect(events).toHaveLength(1);
      expect(events[0][1]).toBe('parked');
      expect(events[0][2]).toBe(9);
      expect(events[0][3]).toContain('(timeout)');
      expect(events.some(e => e[1] === 'timeout')).toBe(false);
    });

    it('parks the lane without re-emitting the terminal event (shipIssue owns it) on a plain fail error', async () => {
      const calls: any[] = [];
      await runLane('app', [10], '/repo', 'on-par/software-factory', paths, {
        ship: async () => { throw new Error('boom'); },
        waitMerge: async () => { throw new Error('waitMerge should not be called'); },
        pathExists: () => false,
        emitEvent: (_events: string, type: string, issue: string | number, msg: string) => calls.push(['event', type, issue, msg]),
      });

      const events = calls.filter(c => c[0] === 'event');
      expect(events).toHaveLength(1);
      expect(events[0][1]).toBe('parked');
      expect(events[0][2]).toBe(10);
      expect(events[0][3]).toContain('(fail)');
      expect(events.some(e => e[1] === 'fail')).toBe(false);
    });

    it('parks the lane without re-emitting the terminal event (land path owns it) on a conflict error from waitMerge', async () => {
      const calls: any[] = [];
      await runLane('app', [11], '/repo', 'on-par/software-factory', paths, {
        ship: async (issue) => { calls.push(['ship', issue]); return 'ship-it/11-x'; },
        waitMerge: async () => { throw new LandConflictError('rebase conflict on ship-it/11-x — parked'); },
        pathExists: () => false,
        emitEvent: (_events: string, type: string, issue: string | number, msg: string) => calls.push(['event', type, issue, msg]),
      });

      expect(calls[0]).toEqual(['ship', 11]);
      const events = calls.filter(c => c[0] === 'event');
      expect(events).toHaveLength(1);
      expect(events[0][1]).toBe('parked');
      expect(events[0][2]).toBe(11);
      expect(events[0][3]).toContain('(conflict)');
      expect(events.some(e => e[1] === 'conflict')).toBe(false);
    });

    it('runs both issues and logs lane-done on the green path', async () => {
      const calls: any[] = [];
      await runLane('app', [1, 2], '/repo', 'on-par/software-factory', paths, {
        ship: async (issue) => { calls.push(['ship', issue]); return `ship-it/${issue}-x`; },
        waitMerge: async (issue) => { calls.push(['waitMerge', issue]); },
        pathExists: () => false,
        emitEvent: (_events: string, type: string, issue: string | number, msg: string) => calls.push(['event', type, issue, msg]),
      });

      expect(calls.filter(c => c[0] === 'ship')).toEqual([['ship', 1], ['ship', 2]]);
      expect(calls.filter(c => c[0] === 'waitMerge')).toEqual([['waitMerge', 1], ['waitMerge', 2]]);
      expect(calls.some(c => c[0] === 'event' && c[1] === 'parked')).toBe(false);
      const lastEvent = calls.filter(c => c[0] === 'event').at(-1);
      expect(lastEvent).toEqual(['event', 'lane-done', 'app', 'lane complete']);
    });

    it('threads the run repoRoot and ghRepo into ship instead of re-resolving per issue', async () => {
      const seen: any[] = [];
      await runLane('app', [1, 2], '/repo', 'on-par/software-factory', paths, {
        ship: async (_issue, _opts, ctx) => { seen.push(ctx); return 'ship-it/x'; },
        waitMerge: async () => {},
        pathExists: () => false,
        emitEvent: () => {},
      });
      expect(seen).toEqual([
        { repoRoot: '/repo', ghRepo: 'on-par/software-factory' },
        { repoRoot: '/repo', ghRepo: 'on-par/software-factory' },
      ]);
    });
  });

  describe('formatDoctorReport', () => {
    const diagnoses: ModelDiagnosis[] = [
      { model: 'claude-opus-4-8', provider: 'anthropic', tiers: ['boss'], reachable: true, experimental: false, reason: 'ok (claude CLI)' },
      { model: 'gpt-5.1-codex', provider: 'openai', tiers: ['worker'], reachable: false, experimental: false, reason: 'codex CLI not found on PATH' },
    ];

    it('renders one line per diagnosis with model, provider, tiers, and reason', () => {
      const report = formatDoctorReport(diagnoses);
      expect(report).toContain('== Model Doctor ==');
      expect(report).toContain('claude-opus-4-8');
      expect(report).toContain('provider=anthropic');
      expect(report).toContain('tier=boss');
      expect(report).toContain('ok (claude CLI)');
      expect(report).toContain('gpt-5.1-codex');
      expect(report).toContain('provider=openai');
      expect(report).toContain('tier=worker');
      expect(report).toContain('codex CLI not found on PATH');
    });

    it('marks reachable models with a check and unreachable models with an x', () => {
      const report = formatDoctorReport(diagnoses);
      const lines = report.split('\n');
      expect(lines.find(l => l.includes('claude-opus-4-8'))).toContain('✅');
      expect(lines.find(l => l.includes('gpt-5.1-codex'))).toContain('❌');
    });
  });

  describe('hasReachableWorker', () => {
    it('is false when every model is unreachable', () => {
      const diagnoses: ModelDiagnosis[] = [
        { model: 'gpt-5.1-codex', provider: 'openai', tiers: ['worker'], reachable: false, experimental: false, reason: 'codex CLI not found on PATH' },
      ];
      expect(hasReachableWorker(diagnoses)).toBe(false);
    });

    it('is false when the only reachable model is boss-tier', () => {
      const diagnoses: ModelDiagnosis[] = [
        { model: 'claude-opus-4-8', provider: 'anthropic', tiers: ['boss'], reachable: true, experimental: false, reason: 'ok (claude CLI)' },
      ];
      expect(hasReachableWorker(diagnoses)).toBe(false);
    });

    it('is true when a worker-tier model is reachable', () => {
      const diagnoses: ModelDiagnosis[] = [
        { model: 'gpt-5.1-codex', provider: 'openai', tiers: ['worker'], reachable: true, experimental: false, reason: 'ok (codex CLI)' },
      ];
      expect(hasReachableWorker(diagnoses)).toBe(true);
    });

    it('is true when a worker_fallback-tier model is reachable', () => {
      const diagnoses: ModelDiagnosis[] = [
        { model: 'claude-sonnet-5', provider: 'anthropic', tiers: ['checker', 'worker_fallback'], reachable: true, experimental: false, reason: 'ok (claude CLI)' },
      ];
      expect(hasReachableWorker(diagnoses)).toBe(true);
    });
  });

  describe('constitution scaffolder', () => {
    const TEMPLATE = `# Constitution Template

Some prose about writing a constitution.

## Format

\`\`\`markdown
---
product: <product-name>
version: 1
checkers:
  - example-checker
enforced_on: [plan, build, check]
---

# <Product> Constitution

## Purpose
<One paragraph>

## Standards

## Quality Gates

## Dispute Rules

## Non-Goals
\`\`\`

## Writing a Constitution

More prose here.
`;

    it('scaffoldConstitution fills the product name in', () => {
      const result = scaffoldConstitution(TEMPLATE, 'acme-app');
      expect(result).toContain('product: "acme-app"');
      expect(result).toContain('# Acme App Constitution');
      expect(result).not.toContain('<product-name>');
      expect(result).not.toContain('<Product>');
    });

    it('scaffoldConstitution quotes an all-digit product name so YAML parses it as a string', () => {
      const result = scaffoldConstitution(TEMPLATE, '2024');
      expect(result).toContain('product: "2024"');
    });

    it('scaffoldConstitution collapses repeated/trailing separators without stray spaces in the heading', () => {
      expect(scaffoldConstitution(TEMPLATE, 'acme--app')).toContain('# Acme App Constitution');
      expect(scaffoldConstitution(TEMPLATE, 'acme-')).toContain('# Acme Constitution');
    });

    it('scaffoldConstitution extracts the skeleton, not the surrounding docs', () => {
      const result = scaffoldConstitution(TEMPLATE, 'acme-app');
      expect(result).not.toContain('Writing a Constitution');
    });

    it('scaffoldConstitution throws when no ```markdown block exists', () => {
      expect(() => scaffoldConstitution('# just some docs, no fenced block', 'acme-app')).toThrow();
    });

    it('initConstitution scaffolds a product (happy path)', () => {
      const writeFile = vi.fn();
      const target = initConstitution('acme-app', {
        dir: '/constitutions',
        readFile: () => TEMPLATE,
        fileExists: () => false,
        writeFile,
      });

      expect(target).toMatch(/\/acme-app\.md$/);
      expect(writeFile).toHaveBeenCalledTimes(1);
      const [writtenPath, writtenContent] = writeFile.mock.calls[0];
      expect(writtenPath).toBe(target);
      expect(writtenContent).toContain('product: "acme-app"');
      expect(writtenContent).toContain('# Acme App Constitution');
    });

    it('initConstitution refuses to clobber an existing constitution', () => {
      const writeFile = vi.fn(() => {
        throw new Error('writeFile should not be called');
      });

      expect(() =>
        initConstitution('acme-app', {
          dir: '/constitutions',
          readFile: () => TEMPLATE,
          fileExists: () => true,
          writeFile,
        }),
      ).toThrow(ConstitutionExistsError);
      expect(writeFile).not.toHaveBeenCalled();
    });

    it('assertValidProduct rejects unsafe names and accepts normal ones', () => {
      expect(() => assertValidProduct('../evil')).toThrow(InvalidProductNameError);
      expect(() => assertValidProduct('_reserved')).toThrow(InvalidProductNameError);
      expect(() => assertValidProduct('a/b')).toThrow(InvalidProductNameError);
      expect(() => assertValidProduct('acme-app')).not.toThrow();
    });
  });

  describe('publish contract', () => {
    it('PREREQUISITES_TEXT mentions all three prerequisites', () => {
      expect(PREREQUISITES_TEXT).toMatch(/Claude/);
      expect(PREREQUISITES_TEXT).toMatch(/gh auth/);
      expect(PREREQUISITES_TEXT).toMatch(/GITHUB_TOKEN/);
    });

    it('pins the publish-critical fields of package.json', () => {
      const cliPkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));
      expect(cliPkg.files).toEqual(['dist']);
      expect(cliPkg.publishConfig.access).toBe('public');
      expect(cliPkg.bin.factory).toBe('dist/cli.js');
      expect(typeof cliPkg.version).toBe('string');
      expect(cliPkg.version).toMatch(/^\d+\.\d+\.\d+/);
    });
  });
});
