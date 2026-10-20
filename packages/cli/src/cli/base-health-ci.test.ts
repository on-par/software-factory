import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createTempDirs } from '@on-par/factory-core/testing';
import type { Octokit } from '@octokit/rest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { baseChecksVerdict, baseHealthWithCi, resetBasePushWorkflowReports } from './base-health-ci.js';

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

const tmp = createTempDirs();
beforeEach(() => resetBasePushWorkflowReports());
afterEach(() => tmp.cleanup());

describe('baseChecksVerdict (#3290)', () => {
  it('is green on CI and logs one base_push_workflow_failed event per SHA for a failed Release', async () => {
    const base = octokit403() as any;
    base.rest.checks.listForRef = async () => ({
      data: {
        check_runs: [
          { name: 'ci', status: 'completed', conclusion: 'success', check_suite: { id: 1 } },
          { name: 'release', status: 'completed', conclusion: 'failure', check_suite: { id: 2 } },
        ],
      },
    });
    base.rest.actions.listWorkflowRunsForRepo = async () => ({
      data: {
        workflow_runs: [
          { name: 'CI', status: 'completed', conclusion: 'success', check_suite_id: 1 },
          { name: 'Release', status: 'completed', conclusion: 'failure', check_suite_id: 2 },
        ],
      },
    });
    const events = join(tmp.makeSync('bhci-'), 'events.jsonl');
    const verdict = baseChecksVerdict(base as Octokit, 'o', 'r', { events, lane: 'lane-1' });
    const sha = 'd'.repeat(40);
    expect((await verdict(sha)).green).toBe(true);
    expect((await verdict(sha)).green).toBe(true);
    const logged = readFileSync(events, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((e) => e.type === 'base_push_workflow_failed');
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      lane: 'lane-1',
      msg: expect.stringContaining('push workflow Release failure on dddddddd'),
    });
  });
});

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
