import type { Octokit } from '@octokit/rest';
import { describe, expect, it, vi } from 'vitest';
import { fakeOctokit } from '../harness/fake-octokit.js';

import { CI_EVIDENCE_LIMITS, collectCiFailureEvidence, collectFailingJobLogs } from './ci-evidence.js';

function octokitFixture(runs: unknown[] | Error, alerts?: unknown[] | Error | null) {
  const listForRef = vi.fn(async () => {
    if (runs instanceof Error) throw runs;
    return { data: { check_runs: runs } };
  });
  const listAlertsForRepo = vi.fn(async () => {
    if (alerts instanceof Error) throw alerts;
    return { data: alerts ?? [] };
  });
  const { octokit } = fakeOctokit({
    'checks.listForRef': listForRef,
    ...(alerts !== null ? { 'codeScanning.listAlertsForRepo': listAlertsForRepo } : {}),
  });
  return { octokit: octokit as Octokit, listForRef, listAlertsForRepo };
}

const base = { owner: 'o', repo: 'r', ref: 'branch', prNumber: 123 };

describe('collectCiFailureEvidence (#2814)', () => {
  it('collects failing checks and CodeQL alerts from the PR merge ref', async () => {
    const message = 'The URL of this request depends on a user-provided value.';
    const { octokit, listAlertsForRepo } = octokitFixture(
      [
        { name: 'lint', status: 'completed', conclusion: 'success' },
        { name: 'CodeQL', status: 'completed', conclusion: 'failure', output: { summary: '1 new alert' } },
      ],
      [
        {
          rule: { id: 'js/request-forgery' },
          most_recent_instance: {
            location: { path: 'packages/core/src/sandbox/egress-proxy.ts', start_line: 130 },
            message: { text: message },
          },
        },
      ],
    );
    const evidence = await collectCiFailureEvidence({ octokit, ...base });
    expect(evidence.failingChecks).toEqual([{ name: 'CodeQL', conclusion: 'failure', summary: '1 new alert' }]);
    expect(evidence.alerts[0]).toEqual({
      ruleId: 'js/request-forgery',
      location: 'packages/core/src/sandbox/egress-proxy.ts:130',
      message,
    });
    expect(evidence.truncated).toBe(false);
    expect(evidence.errors).toBeUndefined();
    expect(listAlertsForRepo).toHaveBeenCalledWith(
      expect.objectContaining({ ref: 'refs/pull/123/merge', state: 'open' }),
    );
  });

  it('records the GitHub alert number when present (#3712)', async () => {
    const { octokit } = octokitFixture(
      [{ name: 'CodeQL', status: 'completed', conclusion: 'failure' }],
      [{ number: 7, rule: { id: 'js/xss' }, most_recent_instance: { location: { path: 'a.ts', start_line: 2 } } }],
    );
    const evidence = await collectCiFailureEvidence({ octokit, ...base });
    expect(evidence.alerts[0]).toMatchObject({ number: 7, ruleId: 'js/xss', location: 'a.ts:2' });
  });

  it('does not query code scanning when no failing check is CodeQL', async () => {
    const { octokit, listAlertsForRepo } = octokitFixture(
      [{ name: 'tests', status: 'completed', conclusion: 'failure' }],
      [],
    );
    const evidence = await collectCiFailureEvidence({ octokit, ...base });
    expect(evidence.failingChecks).toEqual([{ name: 'tests', conclusion: 'failure' }]);
    expect(evidence.alerts).toEqual([]);
    expect(listAlertsForRepo).not.toHaveBeenCalled();
  });

  it('truncates checks, alerts, summaries and messages to the caps', async () => {
    const runs = Array.from({ length: 15 }, (_, i) => ({
      name: `CodeQL ${i}`,
      status: 'completed',
      conclusion: 'failure',
      output: { summary: 'x'.repeat(2000) },
    }));
    const alerts = Array.from({ length: 15 }, (_, i) => ({
      rule: { id: `rule-${i}` },
      most_recent_instance: { location: { path: 'a.ts' }, message: { text: 'y'.repeat(1000) } },
    }));
    const { octokit } = octokitFixture(runs, alerts);
    const evidence = await collectCiFailureEvidence({ octokit, ...base });
    expect(evidence.failingChecks).toHaveLength(CI_EVIDENCE_LIMITS.maxChecks);
    expect(evidence.alerts).toHaveLength(CI_EVIDENCE_LIMITS.maxAlerts);
    for (const c of evidence.failingChecks) {
      expect(c.summary?.length).toBeLessThanOrEqual(CI_EVIDENCE_LIMITS.maxSummaryChars);
      expect(c.summary?.endsWith('…')).toBe(true);
    }
    for (const a of evidence.alerts) {
      expect(a.message.length).toBeLessThanOrEqual(CI_EVIDENCE_LIMITS.maxMessageChars);
      expect(a.message.endsWith('…')).toBe(true);
      expect(a.location).toBe('a.ts');
    }
    expect(evidence.truncated).toBe(true);
  });

  it('handles null conclusion, missing name, and alerts without a location', async () => {
    const { octokit } = octokitFixture(
      [
        { status: 'completed', conclusion: null },
        { name: 'CodeQL', status: 'completed', conclusion: 'failure' },
      ],
      [{ rule: { name: 'named-rule' } }],
    );
    const evidence = await collectCiFailureEvidence({ octokit, ...base });
    expect(evidence.failingChecks[0]).toEqual({ name: '(unnamed)', conclusion: 'null' });
    expect(evidence.alerts).toEqual([{ ruleId: 'named-rule', location: '(unknown location)', message: '' }]);
  });

  it('never throws: records list and code-scanning errors', async () => {
    const listFail = octokitFixture(new Error('boom'));
    const a = await collectCiFailureEvidence({ octokit: listFail.octokit, ...base });
    expect(a).toEqual({ failingChecks: [], alerts: [], truncated: false, errors: ['checks: boom'] });

    const csFail = octokitFixture([{ name: 'CodeQL', status: 'completed', conclusion: 'failure' }], new Error('403'));
    const b = await collectCiFailureEvidence({ octokit: csFail.octokit, ...base });
    expect(b.failingChecks).toHaveLength(1);
    expect(b.errors).toEqual(['code-scanning: 403']);

    const missing = octokitFixture([{ name: 'CodeQL', status: 'completed', conclusion: 'failure' }], null);
    const c = await collectCiFailureEvidence({ octokit: missing.octokit, ...base });
    expect(c.failingChecks).toHaveLength(1);
    expect(c.errors?.[0]).toMatch(/^code-scanning: /);
  });
});

describe('collectFailingJobLogs (#3537)', () => {
  function logOctokit(runs: unknown[] | Error, logs: Record<number, unknown>) {
    const listForRef = vi.fn(async () => {
      if (runs instanceof Error) throw runs;
      return { data: { check_runs: runs } };
    });
    const downloadJobLogsForWorkflowRun = vi.fn(async ({ job_id }: { job_id: number }) => {
      const log = logs[job_id];
      if (log instanceof Error) throw log;
      return { data: log };
    });
    const octokit: Octokit = Object.assign(Object.create(null), {
      rest: { checks: { listForRef }, actions: { downloadJobLogsForWorkflowRun } },
    });
    return { octokit, downloadJobLogsForWorkflowRun };
  }
  const run = (id: number | undefined, name: string, conclusion = 'failure') => ({
    ...(id === undefined ? {} : { id }),
    name,
    status: 'completed',
    conclusion,
  });
  const args = { owner: 'o', repo: 'r', ref: 'sha' };

  it('tails to 150 lines and strips timestamps and ANSI escapes', async () => {
    const text = Array.from({ length: 200 }, (_, i) => `2026-01-01T00:00:00.000Z \u001b[31mline ${i}\u001b[0m`).join(
      '\n',
    );
    const { octokit } = logOctokit([run(1, 'test (1/3)')], { 1: text });
    const { jobLogs, errors } = await collectFailingJobLogs({ octokit, ...args, checkNames: ['test (1/3)'] });
    expect(errors).toEqual([]);
    expect(jobLogs).toHaveLength(1);
    const lines = jobLogs[0].excerpt.split('\n');
    expect(lines).toHaveLength(CI_EVIDENCE_LIMITS.maxLogLines);
    expect(lines.at(-1)).toBe('line 199');
    expect(jobLogs[0]).toMatchObject({ name: 'test (1/3)', jobId: 1, truncated: true });
  });

  it('caps to 3 jobs and only fetches the named failing checks', async () => {
    const runs = [run(1, 'a'), run(2, 'b'), run(3, 'c'), run(4, 'd'), run(5, 'other'), run(6, 'e', 'success')];
    const logs = Object.fromEntries([1, 2, 3, 4, 5, 6].map((i) => [i, `log ${i}`]));
    const { octokit, downloadJobLogsForWorkflowRun } = logOctokit(runs, logs);
    const { jobLogs } = await collectFailingJobLogs({ octokit, ...args, checkNames: ['a', 'b', 'c', 'd', 'e'] });
    expect(jobLogs.map((j) => j.name)).toEqual(['a', 'b', 'c']);
    expect(downloadJobLogsForWorkflowRun).toHaveBeenCalledTimes(3);
    expect(jobLogs[0]).toMatchObject({ excerpt: 'log 1', truncated: false });
  });

  it('records a missing job id and a download error without throwing', async () => {
    const { octokit } = logOctokit([run(undefined, 'a'), run(2, 'b'), run(3, 'c')], {
      2: new Error('gone'),
      3: 'ok',
    });
    const { jobLogs, errors } = await collectFailingJobLogs({ octokit, ...args, checkNames: ['a', 'b', 'c'] });
    expect(errors).toEqual(['a: no job id', 'b: gone']);
    expect(jobLogs.map((j) => j.name)).toEqual(['c']);
  });

  it('records a listing error', async () => {
    const { octokit } = logOctokit(new Error('boom'), {});
    expect(await collectFailingJobLogs({ octokit, ...args, checkNames: ['a'] })).toEqual({
      jobLogs: [],
      errors: ['checks: boom'],
    });
  });

  it('stringifies non-string data and applies the char cap', async () => {
    const { octokit } = logOctokit([run(1, 'a'), run(2, 'b')], { 1: 'x'.repeat(20000), 2: 5 });
    const { jobLogs } = await collectFailingJobLogs({ octokit, ...args, checkNames: ['a', 'b'] });
    expect(jobLogs[0].excerpt).toHaveLength(CI_EVIDENCE_LIMITS.maxLogChars);
    expect(jobLogs[0].truncated).toBe(true);
    expect(jobLogs[1].excerpt).toBe('5');
  });
});
