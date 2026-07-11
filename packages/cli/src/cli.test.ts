import { describe, expect, it } from 'vitest';
import {
  main,
  isPrMerged,
  findOpenPRNumber,
  findOpenPRForIssue,
  squashMergeAndDelete,
  getPullRequestMergeStateStatus,
  landOpenPullRequest,
  waitForMerge,
  LandConflictError,
  resolveUsageKnobs,
  superviseLoop,
} from './cli/index.js';

describe('cli', () => {
  it('exports the main entrypoint', () => {
    expect(typeof main).toBe('function');
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
      ['land', [21, '/repo', 'on-par/software-factory', paths, octokit]],
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

  it('reads the pull request mergeStateStatus field', async () => {
    const calls: any[] = [];
    const octokit: any = {
      graphql: async (query: string, vars: any) => {
        calls.push({ query, vars });
        return { repository: { pullRequest: { mergeStateStatus: 'DIRTY' } } };
      },
    };

    await expect(
      getPullRequestMergeStateStatus(octokit, 'on-par', 'software-factory', 123),
    ).resolves.toBe('DIRTY');
    expect(calls[0].vars).toEqual({ owner: 'on-par', repo: 'software-factory', number: 123 });
    expect(calls[0].query).toContain('mergeStateStatus');
  });

  it('rebases and force-pushes a DIRTY PR before squash-merging it', async () => {
    const calls: any[] = [];
    const octokit: any = {
      graphql: async () => ({ repository: { pullRequest: { mergeStateStatus: 'DIRTY' } } }),
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
    });

    expect(calls).toEqual([
      ['run', "gh pr checks '123' --repo 'on-par/software-factory' --watch --fail-fast", { cwd: '/repo', timeout: 600_000 }],
      ['run', 'git rebase origin/main', { cwd: '/repo-factory-20' }],
      ['run', "git push --force-with-lease origin 'ship-it/20-dirty'", { cwd: '/repo-factory-20' }],
      ['run', "gh pr checks '123' --repo 'on-par/software-factory' --watch --fail-fast", { cwd: '/repo', timeout: 600_000 }],
      ['merge', { owner: 'on-par', repo: 'software-factory', pull_number: 123, merge_method: 'squash' }],
      ['deleteRef', { owner: 'on-par', repo: 'software-factory', ref: 'heads/ship-it/20-dirty' }],
    ]);
  });

  it('aborts the rebase, logs conflict with the branch, and skips merge when rebase fails', async () => {
    const calls: any[] = [];
    const octokit: any = {
      graphql: async () => ({ repository: { pullRequest: { mergeStateStatus: 'DIRTY' } } }),
      rest: {
        pulls: {
          merge: async (args: any) => {
            calls.push(['merge', args]);
          },
        },
        git: { deleteRef: async () => {} },
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
      }),
    ).rejects.toBeInstanceOf(LandConflictError);

    expect(calls).toEqual([
      ['run', "gh pr checks '123' --repo 'on-par/software-factory' --watch --fail-fast", { cwd: '/repo', timeout: 600_000 }],
      ['run', 'git rebase origin/main', { cwd: '/repo-factory-20' }],
      ['run', 'git rebase --abort', { cwd: '/repo-factory-20' }],
      ['log', 'conflict', 'rebase conflict on ship-it/20-dirty — parked'],
    ]);
  });

  it('logs conflict and skips merge when a DIRTY PR worktree is gone', async () => {
    const calls: any[] = [];
    const octokit: any = {
      graphql: async () => ({ repository: { pullRequest: { mergeStateStatus: 'DIRTY' } } }),
      rest: {
        pulls: {
          merge: async (args: any) => {
            calls.push(['merge', args]);
          },
        },
        git: { deleteRef: async () => {} },
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
      }),
    ).rejects.toBeInstanceOf(LandConflictError);

    expect(calls).toEqual([
      ['run', "gh pr checks '123' --repo 'on-par/software-factory' --watch --fail-fast", { cwd: '/repo', timeout: 600_000 }],
      ['log', 'conflict', 'PR #123 DIRTY on ship-it/20-dirty and worktree gone'],
    ]);
  });
});
