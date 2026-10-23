import { describe, expect, it } from 'vitest';

import type { CiFailureEvidence } from '../types/index.js';
import {
  attributableCodeqlAlerts,
  attributeCiFailure,
  ciCheckReworkSummary,
  ciReworkSummary,
  listBaseFailingChecks,
  listPrChangedFiles,
  MAX_CI_REWORK_ROUNDS,
  resolveMaxCiReworkRounds,
} from './ci-rework.js';

const alert = (location: string, ruleId = 'js/xss') => ({ ruleId, location, message: 'msg' });
const evidence = (...alerts: ReturnType<typeof alert>[]): CiFailureEvidence => ({
  failingChecks: [{ name: 'CodeQL', conclusion: 'failure', summary: 's' }],
  alerts,
  truncated: false,
});

describe('resolveMaxCiReworkRounds', () => {
  it('defaults to 2 and honors FACTORY_MAX_CI_REWORK_ROUNDS', () => {
    expect(MAX_CI_REWORK_ROUNDS).toBe(2);
    expect(resolveMaxCiReworkRounds({})).toBe(2);
    expect(resolveMaxCiReworkRounds({ FACTORY_MAX_CI_REWORK_ROUNDS: '3' })).toBe(3);
    expect(resolveMaxCiReworkRounds({ FACTORY_MAX_CI_REWORK_ROUNDS: ' 3 ' })).toBe(3);
    expect(resolveMaxCiReworkRounds({ FACTORY_MAX_CI_REWORK_ROUNDS: '0' })).toBe(0);
  });

  it.each(['', 'abc', '-1', '2.5'])('falls back to 2 for %j', (value) => {
    expect(resolveMaxCiReworkRounds({ FACTORY_MAX_CI_REWORK_ROUNDS: value })).toBe(2);
  });
});

describe('attributableCodeqlAlerts', () => {
  const changed = ['src/a.ts', 'src/b.ts'];

  it('keeps alerts on changed files and drops the rest', () => {
    const kept = alert('src/a.ts:10');
    const result = attributableCodeqlAlerts(
      evidence(kept, alert('src/other.ts:1'), alert('(unknown location)')),
      changed,
    );
    expect(result).toEqual([kept]);
  });

  it('keeps a path without a line and normalizes ./', () => {
    expect(attributableCodeqlAlerts(evidence(alert('src/b.ts'), alert('./src/a.ts:2')), changed)).toHaveLength(2);
  });

  it('returns [] for undefined evidence', () => {
    expect(attributableCodeqlAlerts(undefined, changed)).toEqual([]);
  });
});

describe('ciReworkSummary', () => {
  it('renders rule id, path:line and message as one FAIL ci_codeql result', () => {
    const summary = ciReworkSummary([alert('src/a.ts:10', 'js/xss')]);
    expect(summary).toMatchObject({ failures: 1, passes: 0, skips: 0, total: 1 });
    expect(summary.results).toEqual([
      {
        checker: 'ci_codeql',
        result: 'FAIL',
        details: 'CodeQL alerts on files this PR changed:\n- js/xss at src/a.ts:10 — msg',
      },
    ]);
  });
});

describe('listPrChangedFiles', () => {
  it('paginates until a short page', async () => {
    const pages = [Array.from({ length: 100 }, (_, i) => ({ filename: `f${i}` })), [{ filename: 'last' }]];
    const seen: number[] = [];
    const octokit = {
      rest: {
        pulls: {
          listFiles: async (args: { page: number; pull_number: number }) => {
            seen.push(args.page);
            expect(args.pull_number).toBe(9);
            return { data: pages[args.page - 1] };
          },
        },
      },
    } as never;
    const files = await listPrChangedFiles(octokit, 'o', 'r', 9);
    expect(files).toHaveLength(101);
    expect(files.at(-1)).toBe('last');
    expect(seen).toEqual([1, 2]);
  });
});

describe('attributeCiFailure (#2817)', () => {
  const base = { baseRef: 'main', baseSha: 'a'.repeat(40), failing: ['test'] };
  const ev = (over: Partial<CiFailureEvidence>): CiFailureEvidence => ({
    failingChecks: [],
    alerts: [],
    truncated: false,
    ...over,
  });

  it('attributes alerts by changed file', () => {
    const a = attributeCiFailure(ev({ alerts: [alert('src/a.ts:1'), alert('src/z.ts:2')] }), ['src/a.ts'], undefined);
    expect(a.items.map((i) => i.attributable)).toEqual([true, false]);
    expect(a.items[1].reason).toBe('file not changed by this PR');
    expect(a.baseline).toBe(false);
    expect(attributeCiFailure(ev({ alerts: [alert('src/z.ts:2')] }), ['src/a.ts'], undefined).baseline).toBe(true);
  });

  it('marks a check also failing on base as non-attributable baseline', () => {
    const a = attributeCiFailure(ev({ failingChecks: [{ name: 'test', conclusion: 'failure' }] }), [], base);
    expect(a.baseline).toBe(true);
    expect(a.items[0].reason).toBe(`also failing on base main@${'a'.repeat(12)}`);
    expect(a).toMatchObject({ baseRef: 'main', baseSha: base.baseSha });
  });

  it('attributes a check not failing on base', () => {
    const a = attributeCiFailure(ev({ failingChecks: [{ name: 'lint', conclusion: 'failure' }] }), [], base);
    expect(a.baseline).toBe(false);
    expect(a.items[0]).toMatchObject({ attributable: true, reason: `not failing on base main@${'a'.repeat(12)}` });
  });

  it('attributes checks when base is unavailable', () => {
    const a = attributeCiFailure(ev({ failingChecks: [{ name: 'test', conclusion: 'failure' }] }), [], undefined);
    expect(a.items[0]).toMatchObject({ attributable: true, reason: 'base checks unavailable' });
    expect(a.baseRef).toBeUndefined();
  });

  it('folds a CodeQL check into its alerts, but treats it as a check without alerts', () => {
    const codeql = { name: 'CodeQL', conclusion: 'failure' };
    expect(
      attributeCiFailure(ev({ failingChecks: [codeql], alerts: [alert('src/a.ts:1')] }), ['src/a.ts'], base).items,
    ).toHaveLength(1);
    expect(attributeCiFailure(ev({ failingChecks: [codeql] }), [], base).items[0]).toMatchObject({
      kind: 'check',
      ref: 'CodeQL',
    });
  });

  it('is never baseline with collection errors, empty or undefined evidence', () => {
    const errs = ev({ failingChecks: [{ name: 'test', conclusion: 'failure' }], errors: ['checks: boom'] });
    expect(attributeCiFailure(errs, [], base).baseline).toBe(false);
    expect(attributeCiFailure(ev({}), [], base)).toMatchObject({ baseline: false, items: [] });
    expect(attributeCiFailure(undefined, [], base)).toEqual({ baseline: false, items: [] });
  });
});

describe('listBaseFailingChecks', () => {
  it('returns the base ref, sha and deduped completed non-passing check names', async () => {
    const octokit = {
      rest: {
        pulls: { get: async () => ({ data: { base: { ref: 'main' } } }) },
        repos: {
          getBranch: async (a: { branch: string }) => {
            expect(a.branch).toBe('main');
            return { data: { commit: { sha: 'deadbeef' } } };
          },
        },
        checks: {
          listForRef: async (a: { ref: string }) => {
            expect(a.ref).toBe('deadbeef');
            return {
              data: {
                check_runs: [
                  { name: 'test', status: 'completed', conclusion: 'failure' },
                  { name: 'test', status: 'completed', conclusion: 'timed_out' },
                  { name: 'lint', status: 'completed', conclusion: 'success' },
                  { name: 'skip', status: 'completed', conclusion: 'skipped' },
                  { name: 'pending', status: 'in_progress', conclusion: null },
                ],
              },
            };
          },
        },
      },
    } as never;
    expect(await listBaseFailingChecks(octokit, 'o', 'r', 9)).toEqual({
      baseRef: 'main',
      baseSha: 'deadbeef',
      failing: ['test'],
    });
  });
});

describe('ciCheckReworkSummary (#3537)', () => {
  it('lists the failing jobs, their log tails and the fetch errors in one FAIL result', () => {
    const summary = ciCheckReworkSummary(
      [
        { name: 'test (2/3)', conclusion: 'failure', summary: '1 failed' },
        { name: 'static', conclusion: 'failure' },
      ],
      [{ name: 'test (2/3)', jobId: 7, excerpt: 'expected 1 to be 78', truncated: true }],
      ['static: no job id'],
    );
    expect(summary).toMatchObject({ failures: 1, total: 1 });
    const result = summary.results[0];
    expect(result).toMatchObject({ checker: 'ci_checks', result: 'FAIL' });
    expect(result.details).toContain('- test (2/3) (failure) — 1 failed');
    expect(result.details).toContain('- static (failure)');
    expect(result.details).toContain('--- test (2/3) log tail (job 7), truncated ---\nexpected 1 to be 78');
    expect(result.details).toContain('Log fetch errors: static: no job id');
  });

  it('omits the error line when there are none', () => {
    const summary = ciCheckReworkSummary([{ name: 'ci', conclusion: 'failure' }], [], []);
    expect(summary.results[0].details).not.toContain('Log fetch errors');
  });
});
