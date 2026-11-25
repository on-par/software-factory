import type { Octokit } from '@octokit/rest';
import { describe, expect, it, vi } from 'vitest';

import { fakeOctokit } from '../test-support/index.js';
import { recordArgs } from '../test-support/recorders.js';
import {
  CI_EVIDENCE_LIMITS,
  collectCiFailureEvidence,
  collectFailingJobLogs,
  selectLogExcerpt,
} from './ci-evidence.js';

function ciOctokit(runs: unknown[] | Error, alerts?: unknown[] | Error | null) {
  const listForRef = vi.fn(async () => {
    if (runs instanceof Error) throw runs;
    return { data: { check_runs: runs } };
  });
  const { calls: alertCalls, fn: listAlertsForRepo } = recordArgs(async (_params: unknown) => {
    if (alerts instanceof Error) throw alerts;
    return { data: alerts ?? [] };
  });
  const { octokit } = fakeOctokit({
    'checks.listForRef': listForRef,
    ...(alerts !== null ? { 'codeScanning.listAlertsForRepo': listAlertsForRepo } : {}),
  });
  return { octokit: octokit as Octokit, listForRef, alertCalls };
}

const base = { owner: 'o', repo: 'r', ref: 'branch', prNumber: 123 };

const noise = (label: string, n: number): string[] => Array.from({ length: n }, (_, i) => `${label} output ${i}`);

function anchoredLog(): string[] {
  return [
    '##[group]Set up job',
    ...noise('setup', 9),
    '##[endgroup]',
    '##[group]Run npm ci',
    ...noise('install', 88),
    '##[group]Run npm test',
    ...noise('test', 399),
    ' FAIL  src/widget.test.ts > widget > renders',
    'AssertionError: expected 1 to be 2',
    ' × widget > renders the label',
    ' Test Files  1 failed | 4 passed (5)',
    '      Tests  1 failed | 20 passed (21)',
    '##[error]Process completed with exit code 1.',
    '##[group]Run ./scripts/collect-diagnostics.sh',
    ...noise('diagnostics', 199),
    '##[group]Run actions/upload-artifact@v4',
    ...noise('upload', 92),
    '##[error]Artifact upload failed: storage quota exceeded',
  ];
}

describe('collectCiFailureEvidence (#2814)', () => {
  it('collects failing checks and CodeQL alerts from the PR merge ref', async () => {
    const message = 'The URL of this request depends on a user-provided value.';
    const { octokit, alertCalls } = ciOctokit(
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
    expect(alertCalls).toEqual([[expect.objectContaining({ ref: 'refs/pull/123/merge', state: 'open' })]]);
  });

  it('records the GitHub alert number when present (#3712)', async () => {
    const { octokit } = ciOctokit(
      [{ name: 'CodeQL', status: 'completed', conclusion: 'failure' }],
      [{ number: 7, rule: { id: 'js/xss' }, most_recent_instance: { location: { path: 'a.ts', start_line: 2 } } }],
    );
    const evidence = await collectCiFailureEvidence({ octokit, ...base });
    expect(evidence.alerts[0]).toMatchObject({ number: 7, ruleId: 'js/xss', location: 'a.ts:2' });
  });

  it('does not query code scanning when no failing check is CodeQL', async () => {
    const { octokit, alertCalls } = ciOctokit([{ name: 'tests', status: 'completed', conclusion: 'failure' }], []);
    const evidence = await collectCiFailureEvidence({ octokit, ...base });
    expect(evidence.failingChecks).toEqual([{ name: 'tests', conclusion: 'failure' }]);
    expect(evidence.alerts).toEqual([]);
    expect(alertCalls).toEqual([]);
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
    const { octokit } = ciOctokit(runs, alerts);
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
    const { octokit } = ciOctokit(
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
    const listFail = ciOctokit(new Error('boom'));
    const a = await collectCiFailureEvidence({ octokit: listFail.octokit, ...base });
    expect(a).toEqual({ failingChecks: [], alerts: [], truncated: false, errors: ['checks: boom'] });

    const csFail = ciOctokit([{ name: 'CodeQL', status: 'completed', conclusion: 'failure' }], new Error('403'));
    const b = await collectCiFailureEvidence({ octokit: csFail.octokit, ...base });
    expect(b.failingChecks).toHaveLength(1);
    expect(b.errors).toEqual(['code-scanning: 403']);

    const missing = ciOctokit([{ name: 'CodeQL', status: 'completed', conclusion: 'failure' }], null);
    const c = await collectCiFailureEvidence({ octokit: missing.octokit, ...base });
    expect(c.failingChecks).toHaveLength(1);
    expect(c.errors?.[0]).toMatch(/^code-scanning: /);
  });
});

describe('collectCiFailureEvidence url (#3998)', () => {
  it('sets url from html_url, else details_url', async () => {
    const { octokit } = ciOctokit([
      { name: 'a', status: 'completed', conclusion: 'failure', html_url: 'https://gh/a' },
      { name: 'b', status: 'completed', conclusion: 'failure', details_url: 'https://gh/b' },
      { name: 'c', status: 'completed', conclusion: 'failure' },
    ]);
    const ev = await collectCiFailureEvidence({ octokit, ...base });
    expect(ev.failingChecks.map((c) => c.url)).toEqual(['https://gh/a', 'https://gh/b', undefined]);
  });
});

describe('collectFailingJobLogs (#3537)', () => {
  function logOctokit(runs: unknown[] | Error, logs: Record<number, unknown>) {
    const listForRef = vi.fn(async () => {
      if (runs instanceof Error) throw runs;
      return { data: { check_runs: runs } };
    });
    const { calls: downloads, fn: downloadJobLogsForWorkflowRun } = recordArgs(
      async ({ job_id }: { job_id: number }) => {
        const log = logs[job_id];
        if (log instanceof Error) throw log;
        return { data: log };
      },
    );
    const octokit: Octokit = Object.assign(Object.create(null), {
      rest: { checks: { listForRef }, actions: { downloadJobLogsForWorkflowRun } },
    });
    return { octokit, downloads };
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
    const { octokit, downloads } = logOctokit(runs, logs);
    const { jobLogs } = await collectFailingJobLogs({ octokit, ...args, checkNames: ['a', 'b', 'c', 'd', 'e'] });
    expect(jobLogs.map((j) => j.name)).toEqual(['a', 'b', 'c']);
    expect(downloads.map(([p]) => p.job_id)).toEqual([1, 2, 3]);
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

  it('extracts url, files and commits and redacts secrets from the excerpt (#3998)', async () => {
    const sha = 'a'.repeat(20) + '1b2c3d4e5f60718293a4';
    const token = `ghp_${'A1b2'.repeat(9)}`;
    const text = ['Finding: leak', 'File: src/a.ts', `Commit: ${sha}`, `Secret: ${token}`, 'see src/changed.ts:4'].join(
      '\n',
    );
    const { octokit } = logOctokit([{ ...run(1, 'gitleaks'), html_url: 'https://gh/run/1' }], { 1: text });
    const { jobLogs } = await collectFailingJobLogs({
      octokit,
      ...args,
      checkNames: ['gitleaks'],
      changedFiles: ['src/changed.ts', 'src/untouched.ts'],
    });
    expect(jobLogs[0].files).toEqual(['src/changed.ts', 'src/a.ts']);
    expect(jobLogs[0].commits).toEqual([sha]);
    expect(jobLogs[0].url).toBe('https://gh/run/1');
    expect(jobLogs[0].excerpt).toContain('<secret>');
    expect(jobLogs[0].excerpt).not.toContain(token);
  });

  it('records a listing error', async () => {
    const { octokit } = logOctokit(new Error('boom'), {});
    expect(await collectFailingJobLogs({ octokit, ...args, checkNames: ['a'] })).toEqual({
      jobLogs: [],
      errors: ['checks: boom'],
    });
  });

  it('anchors the excerpt on the test failure, not a later unrelated step error (#4337)', async () => {
    const { octokit } = logOctokit([run(1, 'test')], { 1: anchoredLog().join('\n') });
    const { jobLogs } = await collectFailingJobLogs({ octokit, ...args, checkNames: ['test'] });
    const [log] = jobLogs;
    expect(log.excerpt).toContain(' Test Files  1 failed | 4 passed (5)');
    expect(log.excerpt).toContain(' × widget > renders the label');
    expect(log.excerpt).toContain(' FAIL  src/widget.test.ts > widget > renders');
    expect(log.failingStep).toBe('npm test');
    expect(log.truncated).toBe(true);
    expect(log.excerpt.split('\n').length).toBeLessThanOrEqual(CI_EVIDENCE_LIMITS.maxLogLines);
  });

  it('stringifies non-string data and applies the char cap', async () => {
    const { octokit } = logOctokit([run(1, 'a'), run(2, 'b')], { 1: 'x'.repeat(20000), 2: 5 });
    const { jobLogs } = await collectFailingJobLogs({ octokit, ...args, checkNames: ['a', 'b'] });
    expect(jobLogs[0].excerpt).toHaveLength(CI_EVIDENCE_LIMITS.maxLogChars);
    expect(jobLogs[0].truncated).toBe(true);
    expect(jobLogs[1].excerpt).toBe('5');
  });
});

describe('selectLogExcerpt (#4337)', () => {
  const stepWith = (marker: string): string[] => [
    '##[group]Run make check',
    ...noise('a', 199),
    marker,
    ...noise('b', 199),
  ];

  it.each([
    ' FAIL  src/a.test.ts > adds',
    'FAILED tests/test_math.py::test_add',
    '--- FAIL: TestAdd (0.00s)',
    '⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯',
    ' Test Files  1 failed | 2 passed (3)',
    '      Tests  3 failed | 9 passed (12)',
    'Tests:       2 failed, 5 passed, 7 total',
    '  2 failing',
    '  ✘ adds numbers',
    '  ✗ adds numbers',
    '   × adds numbers',
    '##[error]Process completed with exit code 1.',
  ])('anchors on %j and names its step', (marker) => {
    const result = selectLogExcerpt(stepWith(marker));
    expect(result.excerpt.split('\n')).toEqual([...noise('a', 199).slice(-20), marker, ...noise('b', 30)]);
    expect(result).toMatchObject({ truncated: true, failingStep: 'make check' });
  });

  it('falls back to the last 150 lines when no marker is found', () => {
    const lines = ['##[group]Run make check', ...noise('a', 300)];
    const result = selectLogExcerpt(lines);
    expect(result).toEqual({ excerpt: lines.slice(-CI_EVIDENCE_LIMITS.maxLogLines).join('\n'), truncated: true });
  });

  it('returns a short log with markers whole', () => {
    const lines = ['##[group]Run npm test', 'case a', ' FAIL  src/a.test.ts', '##[error]Process completed'];
    expect(selectLogExcerpt(lines)).toEqual({ excerpt: lines.join('\n'), truncated: false, failingStep: 'npm test' });
  });

  it('joins disjoint windows with an elision line', () => {
    const lines = ['##[group]Run npm test', ...noise('a', 99), ' FAIL  first', ...noise('b', 299), ' FAIL  second'];
    const out = selectLogExcerpt(lines).excerpt.split('\n');
    expect(out).toContain('… 249 lines omitted …');
    expect(out).toEqual(expect.arrayContaining([' FAIL  first', ' FAIL  second']));
    expect(out[0]).toBe('a output 79');
    expect(out).toHaveLength(51 + 1 + 21);
  });

  it('keeps the failing step summary when other steps print many markers', () => {
    const lint = Array.from({ length: 10 }, (_, i) => [`  ✗ style rule ${i}`, ...noise(`lint${i}`, 99)]).flat();
    const lines = [
      '##[group]Run npm run lint',
      ...lint,
      '##[group]Run npm test',
      ...noise('test', 100),
      ' Test Files  1 failed | 4 passed (5)',
      ...noise('tail', 50),
      '##[error]Process completed with exit code 1.',
    ];
    const result = selectLogExcerpt(lines);
    expect(result.failingStep).toBe('npm test');
    expect(result.excerpt).toContain(' Test Files  1 failed | 4 passed (5)');
    expect(result.excerpt).toContain('##[error]Process completed with exit code 1.');
    expect(result.excerpt.split('\n').length).toBeLessThanOrEqual(CI_EVIDENCE_LIMITS.maxLogLines);
  });

  it.each([
    ['a setup group before any run step', ['##[group]Set up job', 'x', '##[error]no runner'], 'Set up job'],
    [
      'the run step around a nested group',
      ['##[group]Run actions/checkout@v4', '##[group]Fetch', '##[error]x'],
      'actions/checkout@v4',
    ],
    ['the step holding the first error', ['##[group]Run a', ' FAIL  t', '##[group]Run b', '##[error]boom'], 'b'],
    ['no step when the log has no group', [' FAIL  t'], undefined],
  ])('names %s', (_label, lines, step) => {
    expect(selectLogExcerpt(lines).failingStep).toBe(step);
  });

  const wide = (label: string, n: number, width: number): string[] => noise(label, n).map((l) => l.padEnd(width, '.'));

  it.each([
    ['a long anchored log', [...wide('a', 199, 500), ' FAIL  t', ...wide('b', 199, 500)], 'a output 179.'],
    ['a short anchored log', [' FAIL  t', ...wide('a', 19, 1000)], ' FAIL  t\n'],
  ])('applies the char cap to %s', (_label, lines, start) => {
    const result = selectLogExcerpt(lines);
    expect(result.excerpt).toHaveLength(CI_EVIDENCE_LIMITS.maxLogChars);
    expect(result.excerpt.startsWith(start)).toBe(true);
    expect(result.truncated).toBe(true);
  });
});
