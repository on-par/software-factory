import { describe, expect, it, vi } from 'vitest';

import { shipPhase } from './ship.js';
import { pushAdoptedHead } from './ship-adopt.js';

const ADOPTED = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
const BRANCH = 'factory/7-fix';

function harness(opts: { head: string; pushError?: Error; remote?: string | Error }) {
  const commands: string[] = [];
  const logs: Array<[string, string]> = [];
  const run = async (command: string) => {
    commands.push(command);
    if (command === 'git rev-parse HEAD') return { stdout: `${opts.head}\n` };
    if (command.startsWith('git push')) {
      if (opts.pushError) throw opts.pushError;
      return { stdout: '' };
    }
    if (command.startsWith('git ls-remote')) {
      if (opts.remote instanceof Error) throw opts.remote;
      return { stdout: opts.remote === '' ? '' : `${opts.remote ?? opts.head}\trefs/heads/${BRANCH}\n` };
    }
    return { stdout: '' };
  };
  const call = () =>
    pushAdoptedHead({
      run,
      worktree: '/wt',
      branch: BRANCH,
      prNumber: 9,
      adoptedHeadSha: ADOPTED,
      log: (type, msg) => logs.push([type, msg]),
    });
  return { commands, logs, call };
}

describe('pushAdoptedHead', () => {
  it('fails closed without pushing when HEAD equals the adopted head', async () => {
    const h = harness({ head: ADOPTED });
    const result = await h.call();
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ reason: expect.stringContaining('#1882') });
    expect(h.commands.some((c) => c.startsWith('git push'))).toBe(false);
  });

  it('pushes a plain fast-forward and verifies the remote head', async () => {
    const h = harness({ head: NEW });
    expect(await h.call()).toEqual({ ok: true });
    const push = h.commands.find((c) => c.startsWith('git push'));
    expect(push).toBe(`git push -u origin '${BRANCH}'`);
    expect(push).not.toContain('--force');
    expect(h.logs).toContainEqual(['ship', `pushed ${NEW} onto adopted PR #9`]);
  });

  it('fails when the push is rejected', async () => {
    const h = harness({ head: NEW, pushError: new Error('non-fast-forward') });
    const result = await h.call();
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('rejected') });
  });

  it('fails when ls-remote does not match local HEAD', async () => {
    const h = harness({ head: NEW, remote: 'c'.repeat(40) });
    expect(await h.call()).toMatchObject({ ok: false });
  });

  it('fails when ls-remote is unreadable', async () => {
    const h = harness({ head: NEW, remote: new Error('network down') });
    expect(await h.call()).toMatchObject({ ok: false, reason: expect.stringContaining('network down') });
    const empty = harness({ head: NEW, remote: '' });
    expect(await empty.call()).toMatchObject({ ok: false });
  });
});

describe('shipPhase on an adopted branch', () => {
  const HEAD = 'b'.repeat(40);

  function setup(head: string) {
    const calls: string[] = [];
    const octokit: any = {
      graphql: async () => ({ markPullRequestReadyForReview: { pullRequest: { isDraft: false } } }),
      rest: {
        pulls: {
          list: async () => ({ data: [{ number: 123 }] }),
          create: async () => {
            calls.push('pulls.create');
            return { data: { number: 999 } };
          },
          get: async () => ({ data: { draft: false, node_id: 'PR_1' } }),
        },
        issues: {
          get: async () => ({ data: { title: 't' } }),
          createComment: async () => ({ data: { id: 1 } }),
        },
        checks: {
          listForRef: async () => {
            calls.push('checks.listForRef');
            return { data: { check_runs: [{ status: 'completed', conclusion: 'success' }] } };
          },
        },
      },
    };
    const commands: string[] = [];
    const run = async (command: string) => {
      commands.push(command);
      if (command === 'git rev-parse HEAD') return { stdout: `${head}\n` };
      if (command.startsWith('git ls-remote')) return { stdout: `${head}\trefs/heads/${BRANCH}\n` };
      return { stdout: '' };
    };
    return { octokit, calls, commands, run };
  }

  const ship = (s: ReturnType<typeof setup>) =>
    shipPhase({
      issue: 7,
      repo: 'on-par/software-factory',
      worktree: '/wt',
      branch: BRANCH,
      octokit: s.octokit,
      watchCI: true,
      log: () => {},
      run: s.run,
      adoptedHeadSha: ADOPTED,
    });

  it('adopted branch pushes new commits onto the existing PR and watches CI without creating a PR', async () => {
    const s = setup(HEAD);
    vi.useFakeTimers();
    let result;
    try {
      const promise = ship(s);
      await vi.runAllTimersAsync();
      result = await promise;
    } finally {
      vi.useRealTimers();
    }

    expect(result).toEqual({ ok: true, prNumber: 123, ciOutcome: 'success' });
    expect(s.commands).toContain(`git push -u origin '${BRANCH}'`);
    expect(s.calls).toContain('checks.listForRef');
    expect(s.calls).not.toContain('pulls.create');
  });

  it('adopted branch with no new commit returns ok:false and never watches CI', async () => {
    const s = setup(ADOPTED);
    const result = await ship(s);

    expect(result).toMatchObject({ ok: false, prNumber: 123, reason: expect.stringContaining('#1882') });
    expect(s.commands.some((c) => c.startsWith('git push'))).toBe(false);
    expect(s.calls).toEqual([]);
  });
});
