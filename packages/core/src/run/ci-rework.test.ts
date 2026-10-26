import { describe, expect, it } from 'vitest';

import type { CiFailureEvidence } from '../types/index.js';
import {
  attributableCodeqlAlerts,
  attributeCiFailure,
  ciCheckReworkSummary,
  ciReworkSummary,
  codeqlReportsNewAlerts,
  listBaseCodeqlAlerts,
  listBaseFailingChecks,
  listPrChangedFiles,
  MAX_CI_REWORK_ROUNDS,
  needsBaseAlerts,
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

  it('keeps an unchanged-file alert that is absent on base (#3712)', () => {
    const introduced = { ...alert('src/sink.ts:5'), number: 5 };
    const preexisting = { ...alert('src/old.ts:1'), number: 6 };
    const baseAlerts = { baseRef: 'main', numbers: [6], refs: [] };
    expect(attributableCodeqlAlerts(evidence(introduced, preexisting), changed, baseAlerts)).toEqual([introduced]);
  });
});

describe('needsBaseAlerts (#3712)', () => {
  it('is false without evidence or when every alert is in a changed file', () => {
    expect(needsBaseAlerts(undefined, ['src/a.ts'])).toBe(false);
    expect(needsBaseAlerts(evidence(alert('src/a.ts:1')), ['src/a.ts'])).toBe(false);
  });

  it('is true for an unchanged-file alert or an unknown location', () => {
    expect(needsBaseAlerts(evidence(alert('src/a.ts:1'), alert('src/z.ts:1')), ['src/a.ts'])).toBe(true);
    expect(needsBaseAlerts(evidence(alert('(unknown location)')), ['src/a.ts'])).toBe(true);
  });
});

describe('codeqlReportsNewAlerts (#3712)', () => {
  const withCheck = (name: string, summary?: string): CiFailureEvidence => ({
    failingChecks: [{ name, conclusion: 'failure', ...(summary === undefined ? {} : { summary }) }],
    alerts: [],
    truncated: false,
  });

  it('matches the CodeQL summary phrase case-insensitively', () => {
    expect(codeqlReportsNewAlerts(withCheck('CodeQL', 'NEW ALERTS IN CODE CHANGED BY THIS PULL REQUEST — 3'))).toBe(
      true,
    );
  });

  it('ignores other wording, non-CodeQL checks, missing summaries and no evidence', () => {
    expect(codeqlReportsNewAlerts(withCheck('CodeQL', '1 new alert'))).toBe(false);
    expect(codeqlReportsNewAlerts(withCheck('lint', 'New alerts in code changed by this pull request'))).toBe(false);
    expect(codeqlReportsNewAlerts(withCheck('CodeQL'))).toBe(false);
    expect(codeqlReportsNewAlerts(undefined)).toBe(false);
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
        details: 'CodeQL alerts this PR introduced:\n- js/xss at src/a.ts:10 — msg',
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

  describe('CodeQL data-flow alerts in unchanged files (#3712)', () => {
    const newPhrase = 'New alerts in code changed by this pull request — 3 high';
    const codeql = (summary: string) => ({ name: 'CodeQL', conclusion: 'failure', summary });
    const sink = { ...alert('packages/core/src/daemon/run-store.ts:81', 'js/insecure-temporary-file'), number: 230 };
    const changed = ['packages/core/src/daemon/factoryd-http.ts'];

    it('attributes an alert in an unchanged file that is absent on base and reported new by CodeQL (#3712)', () => {
      const a = attributeCiFailure(ev({ failingChecks: [codeql(newPhrase)], alerts: [sink] }), changed, undefined, {
        baseRef: 'main',
        numbers: [1],
        refs: [],
      });
      expect(a.baseline).toBe(false);
      expect(a.items[0]).toMatchObject({ attributable: true, reason: 'not open on base main' });
      expect(a.items.map((i) => i.reason)).not.toContain('file not changed by this PR');
    });

    it('keeps an alert in an unchanged file that is open on base as baseline even when CodeQL reports new alerts (#3712)', () => {
      const a = attributeCiFailure(ev({ failingChecks: [codeql(newPhrase)], alerts: [sink] }), changed, undefined, {
        baseRef: 'main',
        numbers: [230],
        refs: [],
      });
      expect(a.baseline).toBe(true);
      expect(a.items[0].reason).toContain('also open on base main');
    });

    it('falls back to the CodeQL new-alerts summary when base alerts are unavailable (#3712)', () => {
      const withPhrase = attributeCiFailure(
        ev({ failingChecks: [codeql(newPhrase)], alerts: [sink] }),
        changed,
        undefined,
      );
      expect(withPhrase.baseline).toBe(false);
      expect(withPhrase.items[0]).toMatchObject({
        attributable: true,
        reason: 'CodeQL reports new alerts in code changed by this PR',
      });
      const without = attributeCiFailure(
        ev({ failingChecks: [codeql('1 new alert')], alerts: [sink] }),
        changed,
        undefined,
      );
      expect(without.baseline).toBe(true);
      expect(without.items[0].reason).toBe('file not changed by this PR');
    });

    it('matches a base alert by rule and location when the alert has no number (#3712)', () => {
      const noNumber = alert('src/z.ts:2', 'js/xss');
      const open = { baseRef: 'main', numbers: [], refs: ['js/xss at src/z.ts:2'] };
      expect(attributeCiFailure(ev({ alerts: [noNumber] }), changed, undefined, open).baseline).toBe(true);
      const absent = { baseRef: 'main', numbers: [], refs: [] };
      expect(attributeCiFailure(ev({ alerts: [noNumber] }), changed, undefined, absent).baseline).toBe(false);
    });
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

describe('listBaseCodeqlAlerts (#3712)', () => {
  const alertRow = (n: number) => ({
    number: n,
    rule: { id: 'js/xss' },
    most_recent_instance: { location: { path: `f${n}.ts`, start_line: n } },
  });
  const stub = (pages: unknown[][]) => {
    const calls: { ref: string; state: string; page: number }[] = [];
    const octokit = {
      rest: {
        pulls: { get: async () => ({ data: { base: { ref: 'main' } } }) },
        codeScanning: {
          listAlertsForRepo: async (a: { ref: string; state: string; page: number }) => {
            calls.push(a);
            return { data: pages[a.page - 1] ?? [] };
          },
        },
      },
    } as never;
    return { octokit, calls };
  };

  it('reads open alerts on refs/heads/<base>, paginating until a short page', async () => {
    const full = Array.from({ length: 100 }, (_, i) => alertRow(i + 1));
    const { octokit, calls } = stub([full, [{ number: 500, rule: { name: 'named' } }]]);
    const result = await listBaseCodeqlAlerts(octokit, 'o', 'r', 9);
    expect(calls.map((c) => c.page)).toEqual([1, 2]);
    expect(calls[0]).toMatchObject({ ref: 'refs/heads/main', state: 'open' });
    expect(result.baseRef).toBe('main');
    expect(result.numbers).toHaveLength(101);
    expect(result.numbers.at(-1)).toBe(500);
    expect(result.refs[0]).toBe('js/xss at f1.ts:1');
    expect(result.refs.at(-1)).toBe('named at (unknown location)');
  });

  it('throws when the last allowed page is full', async () => {
    const full = Array.from({ length: 100 }, (_, i) => alertRow(i + 1));
    const { octokit } = stub(Array.from({ length: 10 }, () => full));
    await expect(listBaseCodeqlAlerts(octokit, 'o', 'r', 9)).rejects.toThrow('exceeds 1000 alerts');
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
