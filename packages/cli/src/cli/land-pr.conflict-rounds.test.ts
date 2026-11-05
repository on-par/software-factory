import { parkReasonFor } from '@on-par/factory-core';
import { describe, expect, it } from 'vitest';

import './index.js';
import { LandConflictError, landOpenPullRequest } from './land-pr.js';

/** Scripted land-state reads: the Nth read returns states[N] (the last one repeats). */
function setup(states: string[], maxConflictRounds = 2) {
  const commands: string[] = [];
  const logs: string[] = [];
  const merges: (string | undefined)[] = [];
  let reads = 0;
  let watches = 0;
  let pushes = 0;
  const octokit: any = {
    graphql: async () => {
      const mergeStateStatus = states[Math.min(reads++, states.length - 1)];
      return { repository: { pullRequest: { id: 'PR_1', isDraft: false, mergeStateStatus } } };
    },
    rest: {
      pulls: {
        get: async () => ({ data: { base: { ref: 'main' }, head: { sha: `sha-${pushes}` } } }),
        merge: async (args: any) => {
          merges.push(args.sha);
        },
      },
      git: { deleteRef: async () => {} },
    },
  };
  const run = async (command: string) => {
    commands.push(command);
    if (command.startsWith('git push')) pushes++;
    if (command === 'git status --porcelain -z') return { stdout: '' };
    if (command.startsWith('git rev-parse --git-path')) return { stdout: '.git/operation' };
    if (command.startsWith('test -e')) return { stdout: 'no' };
    if (command === 'git rev-parse --verify HEAD' || command.startsWith('git merge-base'))
      return { stdout: 'a'.repeat(40) };
    return { stdout: '' };
  };
  const watch = async () => {
    watches++;
    return 'success' as const;
  };
  const land = () =>
    landOpenPullRequest({
      octokit,
      owner: 'on-par',
      repoName: 'software-factory',
      ghRepo: 'on-par/software-factory',
      repoRoot: '/repo',
      issue: 1887,
      branch: 'ship-it/1887-conflicts',
      worktree: '/repo-factory-1887',
      prNumber: 321,
      log: (_type, msg) => logs.push(msg),
      run,
      pathExists: () => true,
      sleep: async () => {},
      adminMerge: false,
      watch: watch as any,
      behindProbe: async () => false,
      maxConflictRounds,
    });
  const mergeCommands = () => commands.filter((c) => c === 'git merge --no-edit origin/main');
  return { land, logs, merges, mergeCommands, watchCount: () => watches };
}

describe('landOpenPullRequest: conflict rounds (#1887)', () => {
  it('merges origin/main in round 1 and round 2 when main moves during two CI watches, then merges the green head', async () => {
    // read 1: start; read 2: in-lock after watch 1; read 3: in-lock after watch 2; read 4+: in-lock after watch 3.
    const { land, merges, mergeCommands, watchCount, logs } = setup(['MERGEABLE', 'DIRTY', 'DIRTY', 'MERGEABLE']);
    await expect(land()).resolves.toBeUndefined();
    expect(mergeCommands()).toHaveLength(2);
    expect(watchCount()).toBe(3);
    expect(merges).toEqual(['sha-2']);
    expect(logs.some((m) => m.includes('round=1/2'))).toBe(true);
    expect(logs.some((m) => m.includes('round=2/2'))).toBe(true);
  });

  it('parks as conflict with conflict rounds exhausted (2/2) when the PR is still DIRTY after round 2', async () => {
    const { land, merges, mergeCommands } = setup(['MERGEABLE', 'DIRTY']);
    const err = await land().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LandConflictError);
    expect((err as LandConflictError).parkReason).toBe('conflict');
    expect((err as LandConflictError).message).toMatch(/conflict rounds exhausted \(2\/2\)/);
    expect((err as LandConflictError).rebuild).toBeUndefined();
    expect(mergeCommands()).toHaveLength(2);
    expect(merges).toEqual([]);
    expect(parkReasonFor(err)).not.toBe('fail');
  });

  it('runs no git merge and makes 0 conflict rounds when the PR is MERGEABLE from the start', async () => {
    const { land, merges, mergeCommands, logs } = setup(['MERGEABLE']);
    await land();
    expect(mergeCommands()).toHaveLength(0);
    expect(logs.some((m) => m.includes('action=merge-main'))).toBe(false);
    expect(merges).toHaveLength(1);
  });
});
