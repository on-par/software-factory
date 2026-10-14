import { describe, expect, it } from 'vitest';

import type { CiFailureEvidence } from '../types/index.js';
import {
  attributableCodeqlAlerts,
  ciReworkSummary,
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
