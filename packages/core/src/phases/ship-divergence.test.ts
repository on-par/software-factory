import { workKeyFromIssue } from '../work/work-key.js';
import { describe, expect, it } from 'vitest';

import { shipPhase } from './ship.js';

const allSuccess = [{ status: 'completed', conclusion: 'success' }];

/** Octokit stub with one open draft PR (#123) that records every call. */
function createWatchOctokit(runs: any[]) {
  const calls: any[] = [];
  const octokit = {
    graphql: async (query: string, vars: any) => {
      calls.push(['graphql', query, vars]);
      return { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } };
    },
    rest: {
      pulls: {
        list: async (_args: any) => ({ data: [{ number: 123 }] }),
        get: async (_args: any) => ({ data: { draft: true, node_id: 'PR_1' } }),
      },
      issues: {
        get: async (_args: any) => ({ data: { title: 'Diverged remote' } }),
        createComment: async (args: any) => {
          calls.push(['issues.createComment', args]);
          return { data: { id: 1 } };
        },
      },
      checks: {
        listForRef: async (args: any) => {
          calls.push(['checks.listForRef', args]);
          return { data: { check_runs: runs } };
        },
      },
    },
  };
  return { octokit, calls };
}

describe('shipPhase existing PR divergence (#1815)', () => {
  const BRANCH = 'ship-it/1815-diverged';
  const LOCAL = 'a'.repeat(40);
  const REMOTE = 'b'.repeat(40);
  const PUSH = `git push -u origin '${BRANCH}'`;

  async function ship(opts: { mergeBase?: unknown; pushError?: unknown; remoteAfterPush?: string | null }) {
    const { octokit, calls } = createWatchOctokit(allSuccess);
    const commands: string[] = [];
    let pushed = false;
    const run = async (command: string) => {
      commands.push(command);
      if (command.startsWith('git merge-base --is-ancestor')) {
        if (opts.mergeBase) throw opts.mergeBase;
        return { stdout: '' };
      }
      if (command === PUSH) {
        if (opts.pushError) throw opts.pushError;
        pushed = true;
        return { stdout: '' };
      }
      if (command === 'git rev-parse HEAD') return { stdout: `${LOCAL}\n` };
      if (command === `git ls-remote --heads origin '${BRANCH}'`) {
        const sha = pushed ? opts.remoteAfterPush : REMOTE;
        return { stdout: sha ? `${sha}\trefs/heads/${BRANCH}\n` : '' };
      }
      return { stdout: '' };
    };
    const logs: Array<[string, string]> = [];
    const result = await shipPhase({
      issue: workKeyFromIssue(1815),
      repo: 'on-par/software-factory',
      worktree: '/repo-factory-1815',
      branch: BRANCH,
      octokit: octokit as any,
      watchCI: true,
      log: (type, msg) => logs.push([type, msg]),
      run,
    });
    const called = (name: string) => calls.some(([n]) => n === name);
    return { result, commands, logs, called };
  }

  function expectNothingShipped(r: Awaited<ReturnType<typeof ship>>) {
    expect(r.result.ok).toBe(false);
    expect(r.result.prNumber).toBe(123);
    expect(r.called('issues.createComment')).toBe(false);
    expect(r.called('graphql')).toBe(false);
    expect(r.called('checks.listForRef')).toBe(false);
    expect(r.logs.some(([type]) => type === 'ready' || type === 'evidence')).toBe(false);
    expect(r.commands.some((c) => c.includes('--force'))).toBe(false);
  }

  it('fails closed naming both SHAs without pushing, evidence or ready when origin has commits local HEAD lacks', async () => {
    const r = await ship({ mergeBase: Object.assign(new Error('Command failed'), { code: 1 }) });

    expectNothingShipped(r);
    expect(r.result.reason).toContain(REMOTE);
    expect(r.result.reason).toContain(LOCAL);
    expect(r.commands.some((c) => c.startsWith('git push'))).toBe(false);
    expect(r.logs.some(([type, msg]) => type === 'ship' && msg.includes(REMOTE) && msg.includes(LOCAL))).toBe(true);
  });

  it('treats a remote SHA missing from the local object store as diverged', async () => {
    const r = await ship({
      mergeBase: Object.assign(new Error('Command failed'), { stderr: `fatal: Not a valid commit name ${REMOTE}` }),
    });

    expectNothingShipped(r);
    expect(r.result.reason).toContain(REMOTE);
    expect(r.result.reason).toContain(LOCAL);
    expect(r.commands.some((c) => c.startsWith('git push'))).toBe(false);
  });

  it('fails closed when the ancestry check errors', async () => {
    const r = await ship({ mergeBase: new Error('boom') });

    expectNothingShipped(r);
    expect(r.result.reason).toContain(REMOTE);
    expect(r.result.reason).toContain(LOCAL);
    expect(r.result.reason).toContain('boom');
    expect(r.commands.some((c) => c.startsWith('git push'))).toBe(false);
  });

  it('fails closed without watching CI or marking ready when the push to the open PR is rejected', async () => {
    const r = await ship({
      pushError: Object.assign(new Error('push failed'), { stderr: '! [rejected] HEAD -> x (non-fast-forward)' }),
    });

    expectNothingShipped(r);
    expect(r.result.reason).toContain('non-fast-forward');
    expect(r.commands.filter((c) => c.startsWith('git push'))).toEqual([PUSH]);
  });

  it('fails closed without watching CI or marking ready when the remote head cannot be verified after the push', async () => {
    const r = await ship({ remoteAfterPush: null });

    expectNothingShipped(r);
    expect(r.commands.filter((c) => c.startsWith('git push'))).toEqual([PUSH]);
  });
});
