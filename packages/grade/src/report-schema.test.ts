import { describe, expect, it } from 'vitest';

import { FAILURE_MODE_KINDS, validateGradeReport, type GradeReport } from './report-schema.js';

const full: GradeReport = {
  schemaVersion: 1,
  generatedAt: '2026-10-20T12:00:00.000Z',
  since: '2026-10-01T00:00:00.000Z',
  runCount: 3,
  scores: {
    overall: 0.66,
    runs: [
      { issue: 101, repo: 'on-par/software-factory', model: 'claude-sonnet-5-5', status: 'parked', score: 0.5 },
      { issue: 102, model: 'claude-sonnet-5-5', status: 'ready', score: 0.5 },
      { issue: 103, model: 'claude-sonnet-5-5', status: 'merged', score: 1 },
    ],
  },
  failureModes: [
    {
      kind: 'redundant-test',
      count: 3,
      issues: [101],
      evidence: [{ issue: 101, phase: 'build', source: 'state/events.ndjson', excerpt: 'npm run test' }],
    },
    {
      kind: 'relearn-test-command',
      count: 1,
      issues: [102],
      evidence: [{ issue: 102, phase: 'check', source: 'state/events.ndjson', excerpt: 'pnpm test' }],
    },
  ],
};

const minimal: GradeReport = {
  schemaVersion: 1,
  generatedAt: '2026-10-20T12:00:00.000Z',
  since: null,
  runCount: 0,
  scores: { overall: 1, runs: [] },
  failureModes: [],
};

function errorsFor(value: unknown): string[] {
  const result = validateGradeReport(value);
  expect(result.ok).toBe(false);
  return result.ok ? [] : result.errors;
}

describe('validateGradeReport', () => {
  it('accepts valid reports and rejects malformed ones', () => {
    expect(validateGradeReport(full)).toEqual({ ok: true, report: full });
    expect(validateGradeReport(minimal)).toEqual({ ok: true, report: minimal });

    const { failureModes: _omitted, ...missing } = full;
    expect(errorsFor(missing).join('\n')).toContain('failureModes');
    expect(errorsFor({ ...full, schemaVersion: 2 }).join('\n')).toContain('schemaVersion');
    expect(
      errorsFor({ ...full, scores: { overall: 1, runs: [{ ...full.scores.runs[0], score: 1.5 }] } }).join('\n'),
    ).toContain('scores.runs.0.score');
    expect(errorsFor({ ...full, failureModes: [{ ...full.failureModes[0], kind: 'flaky' }] }).join('\n')).toContain(
      'failureModes.0.kind',
    );
    expect(errorsFor({ ...full, extra: true }).join('\n')).toContain('extra');
    expect(errorsFor({ ...full, generatedAt: 'yesterday' }).join('\n')).toContain('generatedAt');
    expect(errorsFor(null)[0]).toContain('(root)');
    expect(errorsFor('x')[0]).toContain('(root)');
  });

  it('exposes the documented failure-mode kinds', () => {
    expect([...FAILURE_MODE_KINDS]).toEqual([
      'redundant-test',
      'relearn-test-command',
      'repeated-failing-command',
      'park-reason-cluster',
      'model-phase-failure',
    ]);
  });
});
