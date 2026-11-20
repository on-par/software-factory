import { describe, expect, it } from 'vitest';

import './index.js';
import { refuseNoWaitSync, verifyHeadOnce } from './land-pr-no-wait.js';
import { AwaitingCiError, CiUnverifiedError, LandConflictError, landOpenPullRequest } from './land-pr.js';

const SHA = 'sha-no-wait-unit';

type Fake = {
  pull?: Record<string, unknown>;
  runs?: Array<{ name: string; status: string; conclusion: string | null }>;
  graphState?: string;
  pullFails?: boolean;
  protectionFails?: boolean;
};

function fake({ pull = {}, runs, graphState = 'CLEAN', pullFails = false, protectionFails = false }: Fake = {}) {
  const merged: Array<string | undefined> = [];
  const octokit: any = {
    graphql: async () => ({ repository: { pullRequest: { id: 'P', isDraft: false, mergeStateStatus: graphState } } }),
    rest: {
      pulls: {
        get: async () => {
          if (pullFails) throw new Error('pulls read refused');
          const base = { ref: 'main' };
          return { data: { body: '', head: { sha: SHA }, base, mergeable: true, mergeable_state: 'clean', ...pull } };
        },
        merge: async (args: { sha?: string }) => {
          merged.push(args.sha);
          return { data: {} };
        },
      },
      checks: {
        listForRef: async () => ({
          data: { check_runs: runs ?? [{ name: 'ci', status: 'completed', conclusion: 'success' }] },
        }),
      },
      repos: {
        getStatusChecksProtection: async () => {
          if (protectionFails) throw new Error('protection read refused');
          return { data: { contexts: ['ci'], checks: [] } };
        },
        getBranchRules: async () => ({ data: [] }),
        compareCommitsWithBasehead: async () => ({ data: { behind_by: 0 } }),
      },
      git: { deleteRef: async () => {} },
    },
  };
  return { octokit, merged };
}

function readOnce(f: Fake, behindProbe: () => Promise<boolean | undefined> = async () => false) {
  const events: string[] = [];
  const target = { issue: 4307, prNumber: 3, branch: 'factory/4307-unit', log: (type: string) => events.push(type) };
  const result = verifyHeadOnce({ ...target, octokit: fake(f).octokit, owner: 'o', repo: 'r', behindProbe });
  return { result, events };
}

describe('verifyHeadOnce (#4307)', () => {
  it('returns the head it read when the required checks are green and the PR is mergeable', async () => {
    await expect(readOnce({}).result).resolves.toBe(SHA);
  });

  it('an unreadable PR is CiUnverifiedError, never a merge', async () => {
    const { result, events } = readOnce({ pullFails: true });
    await expect(result).rejects.toBeInstanceOf(CiUnverifiedError);
    expect(events).toEqual(['ci-failed']);
  });

  it('a behind probe that fails falls back to the reported merge state', async () => {
    await expect(readOnce({}, () => Promise.reject(new Error('compare refused'))).result).resolves.toBe(SHA);
  });

  it('a dirty merge state is a conflict even when mergeable is reported true', async () => {
    await expect(readOnce({ pull: { mergeable_state: 'dirty' } }).result).rejects.toBeInstanceOf(LandConflictError);
  });

  it('names the required checks it is still waiting for', async () => {
    const { result, events } = readOnce({ runs: [] });
    const message = expect.stringContaining('(ci)');
    await expect(result).rejects.toMatchObject({ headSha: SHA, prNumber: 3, message });
    await expect(result).rejects.toBeInstanceOf(AwaitingCiError);
    expect(events).toEqual(['awaiting-ci']);
  });

  it('an unreadable protection falls back to every check on head, so no checks at all is pending', async () => {
    const { result, events } = readOnce({ runs: [], protectionFails: true });
    await expect(result).rejects.toBeInstanceOf(AwaitingCiError);
    expect(events).toContain('awaiting-ci');
  });
});

describe('refuseNoWaitSync (#4307)', () => {
  const target = { issue: 4307, prNumber: 3, branch: 'factory/4307-unit', log: () => {} };

  it('maps a dirty sync to a conflict and any other sync to an unverified head', () => {
    expect(refuseNoWaitSync('dirty', target)).toBeInstanceOf(LandConflictError);
    expect(refuseNoWaitSync('behind', target)).toBeInstanceOf(CiUnverifiedError);
  });
});

describe('landOpenPullRequest noWait when the merge-time re-read wants a sync (#4307)', () => {
  it.each([
    { graphState: 'BEHIND', error: CiUnverifiedError },
    { graphState: 'DIRTY', error: LandConflictError },
  ])('$graphState at merge time refuses to sync or merge', async ({ graphState, error }) => {
    const { octokit, merged } = fake({ graphState });
    const commands: string[] = [];
    const landing = landOpenPullRequest({
      octokit,
      owner: 'o',
      repoName: 'r',
      ghRepo: 'o/r',
      repoRoot: '/repo',
      issue: 4307,
      branch: 'factory/4307-unit',
      worktree: '/repo-unit',
      prNumber: 3,
      log: () => {},
      run: async (command: string) => commands.push(command),
      adminMerge: false,
      noWait: true,
    });
    await expect(landing).rejects.toBeInstanceOf(error);
    expect(merged).toEqual([]);
    expect(commands).toEqual([]);
  });
});
