import { describe, expect, it, vi } from 'vitest';

import { evaluatePushChecks, evaluateRequiredChecks, fetchRequiredChecksVerdict } from './required-checks.js';

const run = (name: string, status: string | null, conclusion: string | null) => ({ name, status, conclusion });

describe('evaluateRequiredChecks', () => {
  it('is green when every required check completed with success (duplicates collapsed)', () => {
    const runs = [run('a', 'completed', 'success'), run('b', 'completed', 'success'), run('x', 'completed', 'failure')];
    expect(evaluateRequiredChecks(['a', 'b', 'a'], runs)).toEqual({
      green: true,
      reason: 'all 2 required checks succeeded',
      basis: 'required checks: a, b',
    });
  });

  it('fails closed on an empty required set', () => {
    expect(evaluateRequiredChecks([], [run('a', 'completed', 'success')])).toEqual({
      green: false,
      reason: 'no required checks configured',
    });
  });

  it.each(['skipped', 'failure', 'cancelled', 'neutral', 'timed_out', 'action_required', 'stale'])(
    'skipped, failed, cancelled, neutral, in-progress or missing required checks are not green (%s)',
    (conclusion) => {
      expect(evaluateRequiredChecks(['a'], [run('a', 'completed', conclusion)])).toEqual({
        green: false,
        reason: `a ${conclusion}`,
      });
    },
  );

  it('treats null conclusion, in-progress and queued runs as pending/incomplete', () => {
    expect(evaluateRequiredChecks(['a'], [run('a', 'in_progress', null)]).reason).toBe('a pending');
    expect(evaluateRequiredChecks(['a'], [run('a', 'queued', null)]).green).toBe(false);
    expect(evaluateRequiredChecks(['a'], [run('a', 'completed', null)]).reason).toBe('a incomplete');
  });

  it('names a missing check', () => {
    expect(evaluateRequiredChecks(['a', 'b'], [run('a', 'completed', 'success')])).toEqual({
      green: false,
      reason: 'missing b',
    });
  });

  it('any non-success among duplicate runs fails', () => {
    const runs = [run('a', 'completed', 'success'), run('a', 'completed', 'failure')];
    expect(evaluateRequiredChecks(['a'], runs).green).toBe(false);
  });
});

describe('fetchRequiredChecksVerdict', () => {
  const args = { owner: 'o', repo: 'r', branch: 'main', sha: 'f'.repeat(40) };
  const httpError = (status: number) => Object.assign(new Error(`http ${status}`), { status });

  function fake(opts: {
    protection?: unknown;
    rules?: unknown;
    runs?: Array<ReturnType<typeof run> & { check_suite?: { id: number } | null }>;
    workflowRuns?: Array<{ check_suite_id?: number }>;
  }) {
    const settle = (v: unknown) => async () => {
      if (v instanceof Error) throw v;
      return { data: v };
    };
    const listForRef = vi.fn(settle({ check_runs: opts.runs ?? [] }));
    const listWorkflowRunsForRepo = vi.fn(settle({ workflow_runs: opts.workflowRuns ?? [] }));
    const octokit = {
      rest: {
        repos: {
          getStatusChecksProtection: vi.fn(settle(opts.protection ?? httpError(404))),
          getBranchRules: vi.fn(settle(opts.rules ?? httpError(404))),
        },
        checks: { listForRef },
        actions: { listWorkflowRunsForRepo },
      },
    } as never;
    return { octokit, listForRef, listWorkflowRunsForRepo };
  }

  it('unions ruleset contexts when protection is 404', async () => {
    const { octokit, listForRef } = fake({
      rules: [
        { type: 'deletion' },
        { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'ci' }] } },
      ],
      runs: [run('ci', 'completed', 'success')],
    });
    expect((await fetchRequiredChecksVerdict(octokit, args)).green).toBe(true);
    expect(listForRef).toHaveBeenCalledWith({ owner: 'o', repo: 'r', ref: args.sha, per_page: 100, filter: 'latest' });
  });

  it('uses protection contexts and checks when rulesets are 404', async () => {
    const { octokit } = fake({
      protection: { contexts: ['a'], checks: [{ context: 'b' }] },
      runs: [run('a', 'completed', 'success'), run('b', 'completed', 'skipped')],
    });
    expect(await fetchRequiredChecksVerdict(octokit, args)).toEqual({ green: false, reason: 'b skipped' });
  });

  it('treats a 403 on protection as no contexts from that source', async () => {
    const { octokit } = fake({ protection: httpError(403), rules: [{ type: 'required_status_checks' }] });
    expect(await fetchRequiredChecksVerdict(octokit, args)).toEqual({
      green: false,
      reason: 'no required checks configured',
    });
  });

  it('is not green when both sources are empty', async () => {
    const { octokit } = fake({ runs: [run('ci', 'completed', 'success')] });
    expect(await fetchRequiredChecksVerdict(octokit, args)).toEqual({
      green: false,
      reason: 'no required checks configured',
    });
  });

  it('rethrows other API errors', async () => {
    await expect(fetchRequiredChecksVerdict(fake({ protection: httpError(500) }).octokit, args)).rejects.toThrow(
      'http 500',
    );
    await expect(fetchRequiredChecksVerdict(fake({ rules: httpError(500) }).octokit, args)).rejects.toThrow('http 500');
  });

  describe('push fallback (#3195)', () => {
    const inSuite = (name: string, conclusion: string, id: number) => ({
      ...run(name, 'completed', conclusion),
      check_suite: { id },
    });

    it('is green on push-suite runs only, ignoring a failed schedule run', async () => {
      const { octokit, listWorkflowRunsForRepo } = fake({
        runs: [
          inSuite('ci', 'success', 1),
          inSuite('gitleaks', 'success', 1),
          inSuite('pipeline-integration', 'failure', 2),
        ],
        workflowRuns: [{ check_suite_id: 1 }],
      });
      expect(await fetchRequiredChecksVerdict(octokit, args, { pushFallback: true })).toEqual({
        green: true,
        reason: 'all 2 push-triggered checks succeeded',
        basis: 'push checks: ci, gitleaks',
      });
      expect(listWorkflowRunsForRepo).toHaveBeenCalledWith(
        expect.objectContaining({ head_sha: args.sha, event: 'push' }),
      );
    });

    it('is not green when a push-suite run failed', async () => {
      const { octokit } = fake({
        runs: [inSuite('ci', 'failure', 1)],
        workflowRuns: [{ check_suite_id: 1 }],
      });
      expect(await fetchRequiredChecksVerdict(octokit, args, { pushFallback: true })).toEqual({
        green: false,
        reason: 'ci failure',
      });
    });

    it('is not green with no push workflow runs or runs without a check suite', async () => {
      const { octokit } = fake({ runs: [inSuite('ci', 'success', 1), run('vercel', 'completed', 'success')] });
      expect(await fetchRequiredChecksVerdict(octokit, args, { pushFallback: true })).toEqual({
        green: false,
        reason: 'no push-triggered checks',
      });
    });

    it('without pushFallback still reports no required checks and skips the workflow-run lookup', async () => {
      const { octokit, listWorkflowRunsForRepo } = fake({
        runs: [inSuite('ci', 'success', 1)],
        workflowRuns: [{ check_suite_id: 1 }],
      });
      expect((await fetchRequiredChecksVerdict(octokit, args)).reason).toBe('no required checks configured');
      expect(listWorkflowRunsForRepo).not.toHaveBeenCalled();
    });

    it('uses required checks when configured, even with pushFallback', async () => {
      const { octokit, listWorkflowRunsForRepo } = fake({
        protection: { contexts: ['ci'] },
        runs: [inSuite('ci', 'success', 2)],
      });
      expect((await fetchRequiredChecksVerdict(octokit, args, { pushFallback: true })).basis).toBe(
        'required checks: ci',
      );
      expect(listWorkflowRunsForRepo).not.toHaveBeenCalled();
    });
  });
});

describe('evaluatePushChecks', () => {
  it('is not green when empty, pending or not success', () => {
    expect(evaluatePushChecks([])).toEqual({ green: false, reason: 'no push-triggered checks' });
    expect(evaluatePushChecks([run('a', 'in_progress', null)]).reason).toBe('a pending');
    expect(evaluatePushChecks([run('a', 'completed', 'skipped')]).reason).toBe('a skipped');
    expect(evaluatePushChecks([run('a', 'completed', null)]).reason).toBe('a incomplete');
  });

  it('is green when every run succeeded', () => {
    expect(evaluatePushChecks([run('a', 'completed', 'success')]).green).toBe(true);
  });
});
