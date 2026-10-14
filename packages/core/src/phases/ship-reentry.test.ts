import { describe, expect, it, vi } from 'vitest';

import { shipPhase } from './ship.js';

const allSuccess = [{ status: 'completed', conclusion: 'success' }];
const oneFailure = [
  { status: 'completed', conclusion: 'success' },
  { status: 'completed', conclusion: 'failure' },
];

describe('shipPhase — CI rework re-entry (#2816)', () => {
  const BRANCH = 'ship-it/123-rework';
  const NEW_SHA = 'f'.repeat(40);
  const PREV_SHA = 'e'.repeat(40);

  function setup(runs: unknown[], opts: { draft?: boolean; openPr?: number | null; localSha?: string } = {}) {
    const calls: Array<[string, any]> = [];
    const openPr = opts.openPr === undefined ? 123 : opts.openPr;
    const octokit = {
      graphql: async (query: string, vars: unknown) => {
        calls.push(['graphql', { query, vars }]);
        return {};
      },
      rest: {
        pulls: {
          list: async (args: unknown) => {
            calls.push(['pulls.list', args]);
            return { data: openPr === null ? [] : [{ number: openPr }] };
          },
          create: async (args: unknown) => {
            calls.push(['pulls.create', args]);
            return { data: { number: 999 } };
          },
          get: async (args: unknown) => {
            calls.push(['pulls.get', args]);
            return { data: { draft: opts.draft ?? true, node_id: 'PR_1' } };
          },
        },
        issues: {
          createComment: async (args: unknown) => {
            calls.push(['issues.createComment', args]);
            return { data: { id: 1 } };
          },
        },
        checks: {
          listForRef: async (args: unknown) => {
            calls.push(['checks.listForRef', args]);
            return { data: { check_runs: runs } };
          },
        },
      },
    };
    const sha = opts.localSha ?? NEW_SHA;
    const commands: string[] = [];
    const run = async (command: string) => {
      commands.push(command);
      if (command === 'git rev-parse HEAD') return { stdout: `${sha}\n` };
      const m = /^git ls-remote --heads origin '(.+)'$/.exec(command);
      if (m) return { stdout: `${sha}\trefs/heads/${m[1]}\n` };
      return { stdout: '' };
    };
    const go = (reentry: { prNumber: number; previousHeadSha?: string }) =>
      shipPhase({
        issue: 123,
        repo: 'on-par/software-factory',
        worktree: '/repo-factory-123',
        branch: BRANCH,
        octokit: octokit as never,
        watchCI: true,
        log: () => {},
        run,
        reentry,
      });
    return { calls, commands, go };
  }

  async function settled<T>(promise: Promise<T>): Promise<T> {
    await vi.runAllTimersAsync();
    return promise;
  }

  it('re-entry reuses the open PR, pushes, watches the new head SHA and undrafts only on green', async () => {
    const { calls, commands, go } = setup(allSuccess);
    vi.useFakeTimers();
    try {
      const result = await settled(go({ prNumber: 123, previousHeadSha: PREV_SHA }));
      expect(result).toEqual({ ok: true, prNumber: 123, ciOutcome: 'success', headSha: NEW_SHA });
      expect(calls.some(([name]) => name === 'pulls.create')).toBe(false);
      expect(calls.some(([name]) => name === 'issues.createComment')).toBe(false);
      const push = commands.find((c) => c.startsWith('git push'));
      expect(push).toBe(`git push origin '${BRANCH}'`);
      const watched = calls.filter(([name]) => name === 'checks.listForRef');
      expect(watched.length).toBeGreaterThan(0);
      expect(watched.every(([, args]) => args.ref === NEW_SHA)).toBe(true);
      expect(calls.some(([name]) => name === 'graphql')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not undraft when the re-entry watch is red', async () => {
    const { calls, go } = setup(oneFailure);
    vi.useFakeTimers();
    try {
      const result = await settled(go({ prNumber: 123, previousHeadSha: PREV_SHA }));
      expect(result).toMatchObject({ ok: false, prNumber: 123, ciOutcome: 'failure', headSha: NEW_SHA });
      expect(calls.some(([name]) => name === 'graphql')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['no open PR', null],
    ['a different PR number', 77],
  ])('fails without creating a PR when re-entry finds %s', async (_label, openPr) => {
    const { calls, commands, go } = setup(allSuccess, { openPr });
    const result = await go({ prNumber: 123 });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('re-entry expected open PR #123');
    expect(calls.some(([name]) => name === 'pulls.create')).toBe(false);
    expect(commands.some((c) => c.startsWith('git push'))).toBe(false);
  });

  it('fails when the rework made no new commit', async () => {
    const { commands, go } = setup(allSuccess, { localSha: PREV_SHA });
    const result = await go({ prNumber: 123, previousHeadSha: PREV_SHA });
    expect(result).toMatchObject({
      ok: false,
      ciOutcome: 'failure',
      reason: `CI rework produced no new commit on ${BRANCH}`,
    });
    expect(commands.some((c) => c.startsWith('git push'))).toBe(false);
  });
});
