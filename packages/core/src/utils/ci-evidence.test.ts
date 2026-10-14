import type { Octokit } from '@octokit/rest';
import { describe, expect, it, vi } from 'vitest';

import { CI_EVIDENCE_LIMITS, collectCiFailureEvidence } from './ci-evidence.js';

function fakeOctokit(runs: unknown[] | Error, alerts?: unknown[] | Error | null) {
  const listForRef = vi.fn(async () => {
    if (runs instanceof Error) throw runs;
    return { data: { check_runs: runs } };
  });
  const listAlertsForRepo = vi.fn(async () => {
    if (alerts instanceof Error) throw alerts;
    return { data: alerts ?? [] };
  });
  const rest = { checks: { listForRef }, ...(alerts !== null ? { codeScanning: { listAlertsForRepo } } : {}) };
  const octokit: Octokit = Object.assign(Object.create(null), { rest });
  return { octokit, listForRef, listAlertsForRepo };
}

const base = { owner: 'o', repo: 'r', ref: 'branch', prNumber: 123 };

describe('collectCiFailureEvidence (#2814)', () => {
  it('collects failing checks and CodeQL alerts', async () => {
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
      expect.objectContaining({ ref: 'refs/pull/123/head', state: 'open' }),
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
