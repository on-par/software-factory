import type { Octokit } from '@octokit/rest';
import { describe, expect, it, vi } from 'vitest';

import { CI_EVIDENCE_LIMITS, collectCiFailureEvidence } from './ci-evidence.js';

function fakeOctokit(
  runs: unknown[] | Error,
  alerts?: unknown[] | Error | null,
  downloadLogs?: (args: { job_id: number }) => Promise<{ data: unknown }>,
) {
  const listForRef = vi.fn(async () => {
    if (runs instanceof Error) throw runs;
    return { data: { check_runs: runs } };
  });
  const listAlertsForRepo = vi.fn(async () => {
    if (alerts instanceof Error) throw alerts;
    return { data: alerts ?? [] };
  });
  const downloadJobLogsForWorkflowRun = vi.fn(downloadLogs ?? (async () => ({ data: '' })));
  const rest = {
    checks: { listForRef },
    ...(alerts !== null ? { codeScanning: { listAlertsForRepo } } : {}),
    ...(downloadLogs ? { actions: { downloadJobLogsForWorkflowRun } } : {}),
  };
  const octokit: Octokit = Object.assign(Object.create(null), { rest });
  return { octokit, listForRef, listAlertsForRepo, downloadJobLogsForWorkflowRun };
}

const base = { owner: 'o', repo: 'r', ref: 'branch', prNumber: 123 };

describe('collectCiFailureEvidence (#2814)', () => {
  it('collects failing checks and CodeQL alerts from the PR merge ref', async () => {
    const message = 'The URL of this request depends on a user-provided value.';
    const { octokit, listAlertsForRepo } = fakeOctokit(
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

  it('does not query code scanning when no failing check is CodeQL', async () => {
    const { octokit, listAlertsForRepo } = fakeOctokit(
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
    const { octokit } = fakeOctokit(runs, alerts);
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
    const { octokit } = fakeOctokit(
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
    const listFail = fakeOctokit(new Error('boom'));
    const a = await collectCiFailureEvidence({ octokit: listFail.octokit, ...base });
    expect(a).toEqual({ failingChecks: [], alerts: [], truncated: false, errors: ['checks: boom'] });

    const csFail = fakeOctokit([{ name: 'CodeQL', status: 'completed', conclusion: 'failure' }], new Error('403'));
    const b = await collectCiFailureEvidence({ octokit: csFail.octokit, ...base });
    expect(b.failingChecks).toHaveLength(1);
    expect(b.errors).toEqual(['code-scanning: 403']);

    const missing = fakeOctokit([{ name: 'CodeQL', status: 'completed', conclusion: 'failure' }], null);
    const c = await collectCiFailureEvidence({ octokit: missing.octokit, ...base });
    expect(c.failingChecks).toHaveLength(1);
    expect(c.errors?.[0]).toMatch(/^code-scanning: /);
  });
});

describe('collectCiFailureEvidence job logs (#3537)', () => {
  const run = (id: number | undefined, name = `job ${id}`) => ({
    id,
    name,
    status: 'completed',
    conclusion: 'failure',
  });

  it('caps the tail at 150 lines and strips timestamps', async () => {
    const log = Array.from({ length: 200 }, (_, i) => `2026-01-01T00:00:00.123Z line ${i}`).join('\n');
    const { octokit } = fakeOctokit([run(1)], [], async () => ({ data: log }));
    const evidence = await collectCiFailureEvidence({ octokit, ...base });
    const excerpt = evidence.failingChecks[0].logExcerpt ?? '';
    expect(excerpt.startsWith('…line 50\n')).toBe(true);
    expect(excerpt.endsWith('line 199')).toBe(true);
    expect(excerpt).not.toContain('2026-01-01');
    expect(evidence.truncated).toBe(true);
  });

  it('fetches at most 3 jobs and skips CodeQL and id-less checks', async () => {
    const { octokit, downloadJobLogsForWorkflowRun } = fakeOctokit(
      [run(1, 'CodeQL'), run(undefined, 'noid'), run(2), run(3), run(4), run(5)],
      [],
      async () => ({ data: 'boom' }),
    );
    const evidence = await collectCiFailureEvidence({ octokit, ...base });
    expect(downloadJobLogsForWorkflowRun.mock.calls.map(([a]) => a.job_id)).toEqual([2, 3, 4]);
    expect(evidence.failingChecks.find((c) => c.name === 'job 2')?.logExcerpt).toBe('boom');
    expect(evidence.failingChecks.find((c) => c.name === 'job 5')?.logExcerpt).toBeUndefined();
  });

  it('records a log error in logErrors, not errors', async () => {
    const { octokit } = fakeOctokit([run(1)], [], async () => {
      throw new Error('Not Found');
    });
    const evidence = await collectCiFailureEvidence({ octokit, ...base });
    expect(evidence.logErrors).toEqual(['logs job 1: Not Found']);
    expect(evidence.errors).toBeUndefined();
  });

  it('records a missing actions API in logErrors', async () => {
    const { octokit } = fakeOctokit([run(1)], []);
    const evidence = await collectCiFailureEvidence({ octokit, ...base });
    expect(evidence.logErrors).toHaveLength(1);
    expect(evidence.errors).toBeUndefined();
  });

  it('applies the char cap and decodes an ArrayBuffer', async () => {
    const long = 'x'.repeat(CI_EVIDENCE_LIMITS.maxLogChars + 50);
    const { octokit } = fakeOctokit([run(1)], [], async () => ({ data: new TextEncoder().encode(long).buffer }));
    const evidence = await collectCiFailureEvidence({ octokit, ...base });
    expect(evidence.failingChecks[0].logExcerpt).toHaveLength(CI_EVIDENCE_LIMITS.maxLogChars + 1);
    expect(evidence.truncated).toBe(true);
  });
});
