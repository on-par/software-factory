import { describe, expect, it } from 'vitest';

import type { CheckerOutput, CheckResult, CheckSummary } from '../types/index.js';
import {
  type AcceptanceCriterionFinding,
  computeReviewVerdict,
  DETERMINISTIC_CHECKERS,
  type ReviewVerdict,
  type ReviewVerdictInput,
} from './verdict.js';

function summary(...results: CheckerOutput[]): CheckSummary {
  const count = (r: CheckResult) => results.filter((o) => o.result === r).length;
  return {
    failures: count('FAIL'),
    passes: count('PASS'),
    skips: count('SKIP'),
    total: results.length,
    results,
  };
}
const pass = (checker: string): CheckerOutput => ({ checker, result: 'PASS', details: 'ok' });
const fail = (checker: string, details = ''): CheckerOutput => ({
  checker,
  result: 'FAIL',
  details,
});
const skip = (checker: string, details = ''): CheckerOutput => ({
  checker,
  result: 'SKIP',
  details,
});

function input(
  results: CheckerOutput[],
  overrides: Partial<Omit<ReviewVerdictInput, 'summary'>> = {},
): ReviewVerdictInput {
  return {
    summary: summary(...results),
    criteria: [],
    context: 'rich',
    requiredCheckers: ['compile', 'tests', 'lint'],
    ...overrides,
  };
}

const met = (criterion: string): AcceptanceCriterionFinding => ({ criterion, status: 'met' });
const unmet = (criterion: string, detail?: string): AcceptanceCriterionFinding => ({
  criterion,
  status: 'unmet',
  ...(detail === undefined ? {} : { detail }),
});
const advisory = (criterion: string, detail?: string): AcceptanceCriterionFinding => ({
  criterion,
  status: 'advisory',
  ...(detail === undefined ? {} : { detail }),
});

interface Row {
  name: string;
  input: ReviewVerdictInput;
  verdict: ReviewVerdict;
  reasons: string[];
}

const rows: Row[] = [
  {
    name: 'clean PR approves',
    input: input([pass('compile'), pass('tests'), pass('lint')], { criteria: [met('a'), met('b')] }),
    verdict: 'approve',
    reasons: [],
  },
  ...DETERMINISTIC_CHECKERS.map((name): Row => ({
    name: `${name} FAIL requests changes`,
    input: input([pass('other'), fail(name, 'boom')]),
    verdict: 'request changes',
    reasons: [`checker ${name} failed: boom`],
  })),
  {
    name: 'blocking tier hides comment-tier reasons',
    input: input([fail('tests', 'red'), skip('lint'), fail('design-smells')], {
      criteria: [advisory('nit')],
      context: 'thin',
    }),
    verdict: 'request changes',
    reasons: ['checker tests failed: red'],
  },
  {
    name: 'unmet criterion with detail',
    input: input([pass('compile')], { criteria: [unmet('adds the flag', 'flag missing')] }),
    verdict: 'request changes',
    reasons: ['acceptance criterion unmet: adds the flag: flag missing'],
  },
  {
    name: 'unmet criterion without detail',
    input: input([pass('compile')], { criteria: [unmet('adds the flag')] }),
    verdict: 'request changes',
    reasons: ['acceptance criterion unmet: adds the flag'],
  },
  {
    name: 'deterministic FAIL and unmet criterion list checker first',
    input: input([fail('lint', 'style')], { criteria: [unmet('c1')] }),
    verdict: 'request changes',
    reasons: ['checker lint failed: style', 'acceptance criterion unmet: c1'],
  },
  {
    name: 'advisory criteria only',
    input: input([pass('compile')], { criteria: [advisory('n1', 'x'), advisory('n2')] }),
    verdict: 'approve with comments',
    reasons: ['advisory: n1: x', 'advisory: n2'],
  },
  {
    name: 'thin context only',
    input: input([pass('compile')], { context: 'thin' }),
    verdict: 'approve with comments',
    reasons: ['context was thin: the verdict is capped at approve with comments'],
  },
  {
    name: 'required checker SKIP',
    input: input([skip('tests', 'no runner')]),
    verdict: 'approve with comments',
    reasons: ['required checker tests was skipped: no runner'],
  },
  {
    name: 'non-required checker SKIP approves',
    input: input([skip('links', 'offline')]),
    verdict: 'approve',
    reasons: [],
  },
  {
    name: 'PASS whose details say skipped contributes nothing',
    input: input([{ checker: 'tests', result: 'PASS', details: 'skipped: no tests' }]),
    verdict: 'approve',
    reasons: [],
  },
  {
    name: 'non-deterministic checker FAIL',
    input: input([fail('design-smells', 'god class')]),
    verdict: 'approve with comments',
    reasons: ['advisory: checker design-smells failed: god class'],
  },
  {
    name: 'comment-tier reasons are ordered',
    input: input([skip('lint'), fail('custom-x', 'bad')], {
      criteria: [advisory('nit')],
      context: 'thin',
    }),
    verdict: 'approve with comments',
    reasons: [
      'advisory: checker custom-x failed: bad',
      'required checker lint was skipped',
      'advisory: nit',
      'context was thin: the verdict is capped at approve with comments',
    ],
  },
  {
    name: 'blank details add no trailing colon',
    input: input([fail('compile', '   ')], { criteria: [unmet('c', '  ')] }),
    verdict: 'request changes',
    reasons: ['checker compile failed', 'acceptance criterion unmet: c'],
  },
];

describe('computeReviewVerdict', () => {
  it.each(rows)('$name', (row) => {
    expect(computeReviewVerdict(row.input)).toEqual({
      verdict: row.verdict,
      reasons: row.reasons,
    });
  });

  it('does not mutate its input', () => {
    const i = input([fail('tests', 'red'), skip('lint')], { criteria: [advisory('n')] });
    const before = structuredClone(i);
    computeReviewVerdict(i);
    expect(i).toEqual(before);
  });
});
