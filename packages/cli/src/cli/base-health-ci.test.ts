import type { Octokit } from '@octokit/rest';
import { describe, expect, it } from 'vitest';

import { baseHealthWithCi } from './base-health-ci.js';

const forbidden = () => Object.assign(new Error('Forbidden'), { status: 403 });

/** Octokit where branch protection answers 403, there are no rulesets, and every push check run succeeded. */
function octokit403(): Octokit {
  const rest = {
    repos: {
      getStatusChecksProtection: async () => {
        throw forbidden();
      },
      getBranchRules: async () => ({ data: [] }),
    },
    checks: {
      listForRef: async () => ({
        data: { check_runs: [{ name: 'ci', status: 'completed', conclusion: 'success', check_suite: { id: 1 } }] },
      }),
    },
    actions: {
      listWorkflowRunsForRepo: async () => ({
        data: {
          workflow_runs: [{ id: 1, name: 'ci', status: 'completed', conclusion: 'success', check_suite_id: 1 }],
        },
      }),
    },
  };
  return Object.assign({} as Octokit, { rest });
}

describe('baseHealthWithCi (#3287)', () => {
  it('passes pushFallback so a 403 protection API with green push checks is green', async () => {
    const SHA = 'c'.repeat(40);
    const lookup = baseHealthWithCi(octokit403(), 'o', 'r');
    // checkBaseHealth consults the CI lookup for a timed-out compile: green CI drops it, so the base is green.
    const res = await lookup({
      worktree: '/nonexistent',
      constitution: null,
      router: {} as never,
      env: {},
      log: () => {},
      deps: {
        runCommand: (async () => ({ stdout: `${SHA}\n`, exitCode: 0 })) as never,
        runBaseline: (async () => ({
          baseSha: SHA,
          checkers: [{ checker: 'compile', verdict: 'fails-on-base', baseTimedOut: true }],
        })) as never,
        memo: new Map(),
      },
    });
    expect(res.kind).toBe('green');
  });
});
