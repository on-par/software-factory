import { describe, expect, it, vi } from 'vitest';

import {
  classifyRequiredChecks,
  evaluatePushChecks,
  evaluateRequiredChecks,
  fetchRequiredChecksVerdict,
  fetchRequiredContexts,
} from './required-checks.js';

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
    workflowRuns?:
      | Array<{
          name?: string | null;
          status?: string;
          conclusion?: string | null;
          id?: number;
          check_suite_id?: number;
        }>
      | Error;
  }) {
    const settle = (v: unknown) => async () => {
      if (v instanceof Error) throw v;
      return { data: v };
    };
    const listForRef = vi.fn(settle({ check_runs: opts.runs ?? [] }));
    const listWorkflowRunsForRepo = vi.fn(
      settle(opts.workflowRuns instanceof Error ? opts.workflowRuns : { workflow_runs: opts.workflowRuns ?? [] }),
    );
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

    it('a failed Release push workflow does not make the base verdict red when CI passed (ship-it 342b1042)', async () => {
      const events: string[] = [];
      const { octokit } = fake({
        protection: httpError(403),
        rules: httpError(403),
        runs: [inSuite('build', 'success', 1), inSuite('lint', 'success', 1), inSuite('release', 'failure', 2)],
        workflowRuns: [
          { name: 'CI', status: 'completed', conclusion: 'success', id: 11, check_suite_id: 1 },
          { name: 'Release', status: 'completed', conclusion: 'failure', id: 12, check_suite_id: 2 },
        ],
      });
      const verdict = await fetchRequiredChecksVerdict(octokit, args, {
        pushFallback: true,
        log: (_type, msg) => events.push(msg),
      });
      expect(verdict.green).toBe(true);
      expect(events).toHaveLength(1);
      expect(events[0]).toContain('Release');
      expect(events[0]).toContain(args.sha);
      expect(events[0]).toContain('o/r');
    });

    it('an explicit base-health allowlist overrides protection and names a failed contract check', async () => {
      const { octokit, listWorkflowRunsForRepo } = fake({
        protection: { contexts: ['required-ok'] },
        runs: [run('required-ok', 'completed', 'success'), run('contract', 'completed', 'failure')],
      });
      expect(
        await fetchRequiredChecksVerdict(octokit, args, { checks: ['contract', 'ios'], pushFallback: true }),
      ).toEqual({
        green: false,
        reason: 'contract failure',
      });
      expect(listWorkflowRunsForRepo).not.toHaveBeenCalled();
    });

    it('required checks take precedence over CI fallback and a failed Release is logged without changing green', async () => {
      const events: string[] = [];
      const uniqueArgs = { ...args, sha: 'c'.repeat(40) };
      const { octokit } = fake({
        protection: { contexts: ['required-ok'] },
        runs: [inSuite('required-ok', 'success', 3), inSuite('release', 'failure', 4)],
        workflowRuns: [
          { name: 'CI', status: 'completed', conclusion: 'success', id: 31, check_suite_id: 3 },
          { name: 'Release', status: 'completed', conclusion: 'failure', id: 32, check_suite_id: 4 },
        ],
      });
      const verdict = await fetchRequiredChecksVerdict(octokit, uniqueArgs, {
        pushFallback: true,
        log: (_type, msg) => events.push(msg),
      });
      expect(verdict.green).toBe(true);
      expect(events).toHaveLength(1);
      expect(events[0]).toContain('Release');
    });

    it('fails closed naming missing code-health checks when only a successful Release push workflow exists', async () => {
      const { octokit } = fake({
        protection: httpError(403),
        rules: httpError(403),
        runs: [inSuite('release', 'success', 5)],
        workflowRuns: [{ name: 'Release', status: 'completed', conclusion: 'success', id: 51, check_suite_id: 5 }],
      });
      expect(await fetchRequiredChecksVerdict(octokit, args, { pushFallback: true })).toEqual({
        green: false,
        reason: 'missing code-health checks: no push CI check runs',
      });
    });

    it('does not fall back when an explicit selected name is missing or the list is empty', async () => {
      const { octokit } = fake({
        protection: httpError(403),
        rules: httpError(403),
        runs: [inSuite('build', 'success', 6)],
        workflowRuns: [{ name: 'CI', status: 'completed', conclusion: 'success', id: 61, check_suite_id: 6 }],
      });
      expect(await fetchRequiredChecksVerdict(octokit, args, { checks: ['missing'], pushFallback: true })).toEqual({
        green: false,
        reason: 'missing missing',
      });
      expect(await fetchRequiredChecksVerdict(octokit, args, { checks: [], pushFallback: true })).toEqual({
        green: false,
        reason: 'no code-health checks configured',
      });
    });

    it.each([
      ['lowercase ci', 'ci', 8],
      ['missing suite id', 'CI', undefined],
      ['schedule workflow', 'Schedule', 8],
    ])('fails closed for %s without an exact push CI suite', async (_label, name, suiteId) => {
      const { octokit } = fake({
        protection: httpError(403),
        rules: httpError(403),
        runs: [inSuite('check', 'success', 8)],
        workflowRuns: [{ name, status: 'completed', conclusion: 'success', id: 81, check_suite_id: suiteId }],
      });
      expect((await fetchRequiredChecksVerdict(octokit, args, { pushFallback: true })).green).toBe(false);
    });

    it.each([
      ['queued', 'queued', null],
      ['unknown status', 'completed-ish', 'success'],
      ['unknown conclusion', 'completed', 'future-result'],
    ])('keeps selected %s checks red', async (_label, status, conclusion) => {
      const { octokit } = fake({
        protection: httpError(403),
        rules: httpError(403),
        runs: [run('contract', status, conclusion)],
      });
      expect((await fetchRequiredChecksVerdict(octokit, args, { checks: ['contract'] })).green).toBe(false);
    });

    it('deduplicates failed workflow observations and retries after a logger throws', async () => {
      const uniqueArgs = { ...args, sha: 'a'.repeat(40) };
      const { octokit } = fake({
        protection: { contexts: ['required-ok'] },
        runs: [run('required-ok', 'completed', 'success')],
        workflowRuns: [{ name: 'Release', status: 'completed', conclusion: 'failure', id: 71, check_suite_id: 7 }],
      });
      const log = vi.fn();
      await fetchRequiredChecksVerdict(octokit, uniqueArgs, { log });
      await fetchRequiredChecksVerdict(octokit, uniqueArgs, { log });
      expect(log).toHaveBeenCalledTimes(1);
      const throws = vi.fn(() => {
        throw new Error('telemetry unavailable');
      });
      await fetchRequiredChecksVerdict(octokit, { ...args, sha: 'b'.repeat(40) }, { log: throws });
      await fetchRequiredChecksVerdict(octokit, { ...args, sha: 'b'.repeat(40) }, { log });
      expect(throws).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledTimes(2);
    });

    it('does not consume observations without a logger and deduplicates concurrent callers', async () => {
      const uniqueArgs = { ...args, sha: 'e'.repeat(40) };
      const { octokit } = fake({
        protection: { contexts: ['required-ok'] },
        runs: [run('required-ok', 'completed', 'success')],
        workflowRuns: [{ name: 'Release', status: 'completed', conclusion: 'timed_out', id: 91, check_suite_id: 9 }],
      });
      await fetchRequiredChecksVerdict(octokit, uniqueArgs);
      const log = vi.fn();
      await Promise.all([
        fetchRequiredChecksVerdict(octokit, uniqueArgs, { log }),
        fetchRequiredChecksVerdict(octokit, uniqueArgs, { log }),
      ]);
      expect(log).toHaveBeenCalledTimes(1);
    });

    it('keeps named-check verdicts when workflow telemetry lookup fails', async () => {
      const { octokit } = fake({
        protection: { contexts: ['required-ok'] },
        runs: [run('required-ok', 'completed', 'success')],
        workflowRuns: httpError(500),
      });
      await expect(fetchRequiredChecksVerdict(octokit, args, { log: vi.fn() })).resolves.toMatchObject({ green: true });
    });

    it('is green on push-suite runs only, ignoring a failed schedule run', async () => {
      const { octokit, listWorkflowRunsForRepo } = fake({
        runs: [
          inSuite('ci', 'success', 1),
          inSuite('gitleaks', 'success', 1),
          inSuite('pipeline-integration', 'failure', 2),
        ],
        workflowRuns: [{ name: 'CI', status: 'completed', conclusion: 'success', id: 1, check_suite_id: 1 }],
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
        workflowRuns: [{ name: 'CI', status: 'completed', conclusion: 'success', id: 1, check_suite_id: 1 }],
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
        reason: 'missing code-health checks: no push CI check runs',
      });
    });

    it('without pushFallback still reports no required checks and skips the workflow-run lookup', async () => {
      const { octokit, listWorkflowRunsForRepo } = fake({
        runs: [inSuite('ci', 'success', 1)],
        workflowRuns: [{ name: 'CI', status: 'completed', conclusion: 'success', id: 1, check_suite_id: 1 }],
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

describe('classifyRequiredChecks', () => {
  it('is green when every required context completed with success', () => {
    expect(classifyRequiredChecks(['a'], [run('a', 'completed', 'success')])).toEqual({
      state: 'green',
      missing: [],
      pending: [],
      failed: [],
    });
  });

  it('is pending with the missing contexts when a required check has no run', () => {
    expect(classifyRequiredChecks(['verify'], [run('lint', 'completed', 'success')])).toEqual({
      state: 'pending',
      missing: ['verify'],
      pending: [],
      failed: [],
    });
  });

  it('is pending for a queued or in-progress run', () => {
    expect(
      classifyRequiredChecks(['a', 'b'], [run('a', 'queued', null), run('b', 'in_progress', null)]).pending,
    ).toEqual(['a', 'b']);
  });

  it('lists completed runs whose conclusion is not success as failed', () => {
    const rs = classifyRequiredChecks(
      ['a', 'b', 'c'],
      [run('a', 'completed', 'failure'), run('b', 'completed', 'skipped'), run('c', 'completed', null)],
    );
    expect(rs).toEqual({ state: 'failed', missing: [], pending: [], failed: ['a', 'b', 'c'] });
  });

  it('lets failed win over pending and dedupes the required list', () => {
    const rs = classifyRequiredChecks(['a', 'b', 'a'], [run('a', 'completed', 'failure')]);
    expect(rs).toEqual({ state: 'failed', missing: ['b'], pending: [], failed: ['a'] });
  });

  it('returns pending with empty arrays for an empty list', () => {
    expect(classifyRequiredChecks([], [run('a', 'completed', 'success')])).toEqual({
      state: 'pending',
      missing: [],
      pending: [],
      failed: [],
    });
  });
});

describe('fetchRequiredContexts', () => {
  const args = { owner: 'o', repo: 'r', branch: 'main' };
  const notFound = () => Object.assign(new Error('Not Found'), { status: 404 });

  it('returns the deduped protection + rulesets union', async () => {
    const octokit: any = {
      rest: {
        repos: {
          getStatusChecksProtection: async () => ({ data: { contexts: ['a'], checks: [{ context: 'b' }] } }),
          getBranchRules: async () => ({
            data: [
              {
                type: 'required_status_checks',
                parameters: { required_status_checks: [{ context: 'b' }, { context: 'c' }] },
              },
              { type: 'other' },
            ],
          }),
        },
      },
    };
    expect(await fetchRequiredContexts(octokit, args)).toEqual(['a', 'b', 'c']);
  });

  it('returns [] when both lookups 404', async () => {
    const octokit: any = {
      rest: {
        repos: {
          getStatusChecksProtection: async () => {
            throw notFound();
          },
          getBranchRules: async () => {
            throw notFound();
          },
        },
      },
    };
    expect(await fetchRequiredContexts(octokit, args)).toEqual([]);
  });
});
