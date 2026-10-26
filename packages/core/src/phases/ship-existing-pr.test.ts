import { workKeyFromIssue } from '../work/work-key.js';
import { describe, expect, it } from 'vitest';

import { shipPhase } from './ship.js';
import { checkRemoteIsAncestor, pushAndVerifyRemoteHead } from './ship-git.js';

const allSuccess = [{ status: 'completed', conclusion: 'success' }];

/** Octokit stub with one open PR (#123) whose checks are all green. */
function createWatchOctokit(sequence: any[][]) {
  const octokit = {
    graphql: async (_query: string, _vars: any) => ({
      markPullRequestReadyForReview: { pullRequest: { isDraft: false } },
    }),
    rest: {
      pulls: {
        list: async (_args: any) => ({ data: [{ number: 123 }] }),
        get: async (_args: any) => ({ data: { draft: true, node_id: 'PR_1' } }),
      },
      issues: {
        get: async (_args: any) => ({ data: { title: 'Push rework to the open PR' } }),
        createComment: async (_args: any) => ({ data: { id: 1 } }),
      },
      checks: {
        listForRef: async (_args: any) => ({ data: { check_runs: sequence[0] } }),
      },
    },
  };
  return { octokit };
}

describe('shipPhase existing PR push (#1813)', () => {
  const BRANCH = 'ship-it/1813-rework';
  const LOCAL = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const STALE = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const PUSH = `git push -u origin '${BRANCH}'`;

  /** Ships against an open PR; `remoteAfterPush` is what ls-remote reports once the push ran. */
  async function ship(opts: { remoteBefore: string; remoteAfterPush: string; pushError?: unknown }) {
    const { octokit } = createWatchOctokit([allSuccess]);
    const events: string[] = [];
    const commands: string[] = [];
    const wrap = <T extends (...a: any[]) => any>(name: string, fn: T) =>
      ((...a: any[]) => {
        events.push(name);
        return fn(...a);
      }) as T;
    octokit.graphql = wrap('graphql', octokit.graphql);
    octokit.rest.issues.createComment = wrap('issues.createComment', octokit.rest.issues.createComment);
    let pushed = false;
    const run = async (command: string) => {
      commands.push(command);
      events.push(command);
      if (command === PUSH) {
        if (opts.pushError) throw opts.pushError;
        pushed = true;
        return { stdout: '' };
      }
      if (command === 'git rev-parse HEAD') return { stdout: `${LOCAL}\n` };
      if (command === `git ls-remote --heads origin '${BRANCH}'`) {
        return { stdout: `${pushed ? opts.remoteAfterPush : opts.remoteBefore}\trefs/heads/${BRANCH}\n` };
      }
      return { stdout: '' };
    };
    const logs: Array<[string, string]> = [];
    const result = await shipPhase({
      issue: workKeyFromIssue(1813),
      repo: 'on-par/software-factory',
      worktree: '/repo-factory-1813',
      branch: BRANCH,
      octokit: octokit as any,
      watchCI: false,
      log: (type, msg) => logs.push([type, msg]),
      run,
    });
    return { result, events, commands, logs };
  }

  it('pushes local rework commits to the open PR before evidence and ready', async () => {
    const { result, events, commands, logs } = await ship({ remoteBefore: STALE, remoteAfterPush: LOCAL });

    expect(result.ok).toBe(true);
    expect(commands.filter((c) => c === PUSH)).toHaveLength(1);
    const push = events.indexOf(PUSH);
    expect(events.indexOf('issues.createComment')).toBeGreaterThan(push);
    expect(events.indexOf('graphql')).toBeGreaterThan(push);
    expect(logs).toContainEqual(['ship', `remote head ${LOCAL} matches local HEAD ${LOCAL} for ${BRANCH}`]);
    expect(logs.some(([type]) => type === 'ready')).toBe(true);
  });

  it('does not push and logs the match when the open PR is already in sync', async () => {
    const { result, commands, logs } = await ship({ remoteBefore: LOCAL, remoteAfterPush: LOCAL });

    expect(result.ok).toBe(true);
    expect(commands.some((c) => c.startsWith('git push'))).toBe(false);
    expect(logs.some(([type, msg]) => type === 'ship' && /remote head a+ matches local HEAD a+/.test(msg))).toBe(true);
    expect(logs.some(([type]) => type === 'ready')).toBe(true);
  });

  it('fails closed before evidence when the push to the open PR is rejected', async () => {
    const { result, events, logs } = await ship({
      remoteBefore: STALE,
      remoteAfterPush: STALE,
      pushError: Object.assign(new Error('push failed'), { stderr: '! [rejected] HEAD -> x (non-fast-forward)' }),
    });

    expect(result.ok).toBe(false);
    expect(result.prNumber).toBe(123);
    expect(result.reason).toContain('non-fast-forward');
    expect(events).not.toContain('issues.createComment');
    expect(events).not.toContain('graphql');
    expect(logs.some(([type]) => type === 'ready')).toBe(false);
  });

  it('fails closed when the remote head still differs after pushing to the open PR', async () => {
    const { result, events, logs } = await ship({ remoteBefore: STALE, remoteAfterPush: STALE });

    expect(result.ok).toBe(false);
    expect(result.prNumber).toBe(123);
    expect(result.reason).toContain(STALE);
    expect(result.reason).toContain(LOCAL);
    expect(events).not.toContain('issues.createComment');
    expect(events).not.toContain('graphql');
    expect(logs.some(([type]) => type === 'ready')).toBe(false);
  });
});

describe('pushAndVerifyRemoteHead (#1813)', () => {
  const SHA = 'c'.repeat(40);
  const makeRun = (opts: { push?: Error; remote?: string; head?: string | Error }) => async (command: string) => {
    if (command.startsWith('git push')) {
      if (opts.push) throw opts.push;
      return { stdout: '' };
    }
    if (command === 'git rev-parse HEAD') {
      if (opts.head instanceof Error) throw opts.head;
      return { stdout: `${opts.head ?? SHA}\n` };
    }
    return { stdout: opts.remote === undefined ? '' : `${opts.remote}\trefs/heads/b\n` };
  };

  it('reports pushed when the remote head matches', async () => {
    expect(await pushAndVerifyRemoteHead(makeRun({ remote: SHA }), '/w', 'b', 'git push')).toEqual({
      status: 'pushed',
      localSha: SHA,
      remoteSha: SHA,
    });
  });

  it('reports push-failed with the classified kind', async () => {
    const push = Object.assign(new Error('x'), { stderr: '! [rejected] (non-fast-forward)' });
    const out = await pushAndVerifyRemoteHead(makeRun({ push }), '/w', 'b', 'git push');
    expect(out).toMatchObject({ status: 'push-failed', kind: 'non-fast-forward' });
  });

  it('reports mismatch when the remote head differs', async () => {
    const other = 'd'.repeat(40);
    expect(await pushAndVerifyRemoteHead(makeRun({ remote: other }), '/w', 'b', 'git push')).toEqual({
      status: 'mismatch',
      localSha: SHA,
      remoteSha: other,
    });
  });

  it('reports unreadable when the remote head cannot be read', async () => {
    const noRef = await pushAndVerifyRemoteHead(makeRun({}), '/w', 'b', 'git push');
    expect(noRef).toMatchObject({ status: 'unreadable', localSha: SHA });
    const noHead = await pushAndVerifyRemoteHead(makeRun({ head: new Error('boom') }), '/w', 'b', 'git push');
    expect(noHead).toMatchObject({ status: 'unreadable' });
  });
});

describe('checkRemoteIsAncestor (#1815)', () => {
  const check = (err?: unknown) =>
    checkRemoteIsAncestor(
      async () => {
        if (err) throw err;
        return { stdout: '' };
      },
      '/w',
      'b'.repeat(40),
      'a'.repeat(40),
    );

  it('reports ancestor when merge-base resolves', async () => {
    expect(await check()).toEqual({ status: 'ancestor' });
  });

  it('reports diverged on exit code 1', async () => {
    expect(await check(Object.assign(new Error('Command failed'), { code: 1 }))).toEqual({ status: 'diverged' });
  });

  it('reports diverged when the remote object is missing locally', async () => {
    const err = Object.assign(new Error('Command failed'), { code: 128, stderr: 'fatal: Not a valid commit name x' });
    expect(await check(err)).toEqual({ status: 'diverged' });
  });

  it('reports unreadable for any other failure', async () => {
    expect(await check(new Error('boom'))).toMatchObject({
      status: 'unreadable',
      detail: expect.stringContaining('boom'),
    });
    expect(await check('weird')).toMatchObject({ status: 'unreadable' });
  });
});
