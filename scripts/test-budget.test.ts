import { describe, expect, it, vi } from 'vitest';

import {
  evaluateTestBudget,
  isCiEnv,
  resolveTestBudgetSeconds,
  runTestBudgetCli,
  TEST_BUDGET_SECONDS,
} from './test-budget.js';

function report(entries: Array<[string, number]>): unknown {
  return {
    testResults: entries.map(([name, ms]) => ({ name: `/repo/${name}`, startTime: 1000, endTime: 1000 + ms })),
  };
}

const SEVEN: Array<[string, number]> = [
  ['a.test.ts', 100],
  ['b.test.ts', 7000],
  ['c.test.ts', 300],
  ['d.test.ts', 5000],
  ['e.test.ts', 4000],
  ['f.test.ts', 6000],
  ['g.test.ts', 200],
];

function run(argv: string[], env: Record<string, string | undefined>, readFile?: (p: string) => string) {
  const lines: string[] = [];
  const read = vi.fn(readFile ?? (() => JSON.stringify(report(SEVEN))));
  const code = runTestBudgetCli(argv, { readFile: read, log: (l) => lines.push(l), cwd: '/repo', env });
  return { code, lines, read };
}

describe('TEST_BUDGET_SECONDS', () => {
  it('is the stored 450s budget used when FACTORY_TEST_BUDGET_SECONDS is unset', () => {
    expect(TEST_BUDGET_SECONDS).toBe(450);
    expect(resolveTestBudgetSeconds({})).toEqual({ budgetSeconds: 450 });
  });
});

describe('resolveTestBudgetSeconds', () => {
  it('accepts a trimmed positive integer override', () => {
    expect(resolveTestBudgetSeconds({ FACTORY_TEST_BUDGET_SECONDS: '  120 ' })).toEqual({ budgetSeconds: 120 });
  });

  it('treats a blank override as unset', () => {
    expect(resolveTestBudgetSeconds({ FACTORY_TEST_BUDGET_SECONDS: '' })).toEqual({ budgetSeconds: 450 });
  });

  it.each(['abc', '0', '-5', '1.5'])('falls back with a note for %j', (raw) => {
    const result = resolveTestBudgetSeconds({ FACTORY_TEST_BUDGET_SECONDS: raw });
    expect(result.budgetSeconds).toBe(450);
    expect(result.note).toContain(`'${raw}'`);
  });
});

describe('evaluateTestBudget', () => {
  it('is over only when elapsed exceeds the budget', () => {
    expect(evaluateTestBudget(100, 450).overBudget).toBe(false);
    expect(evaluateTestBudget(450, 450).overBudget).toBe(false);
    expect(evaluateTestBudget(451, 450).overBudget).toBe(true);
  });
});

describe('isCiEnv', () => {
  it.each(['true', 'TRUE', '1', 'yes', ' true '])('is true for CI=%j', (value) => {
    expect(isCiEnv({ CI: value })).toBe(true);
  });

  it("is false for unset, blank, 'false' and '0'", () => {
    for (const env of [{}, { CI: '' }, { CI: '  ' }, { CI: 'false' }, { CI: 'FALSE' }, { CI: '0' }]) {
      expect(isCiEnv(env)).toBe(false);
    }
  });
});

describe('runTestBudgetCli', () => {
  it('prints PASS and returns 0 when elapsed is within budget', () => {
    const { code, lines, read } = run(['300', 'r.json'], {});
    expect(code).toBe(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^test-budget: PASS/);
    expect(lines[0]).toContain('300s');
    expect(lines[0]).toContain('450s');
    expect(read).not.toHaveBeenCalled();
  });

  it('prints a WARNING with the slowest files and still returns 0 when over budget', () => {
    const { code, lines } = run(['500', 'r.json'], {});
    const out = lines.join('\n');
    expect(code).toBe(0);
    expect(lines[0]).toMatch(/^test-budget: WARNING/);
    expect(lines[0]).toContain('500s');
    expect(lines[0]).toContain('450s');
    expect(out).toContain('Slowest 5 test files:');
    expect(out).toContain('b.test.ts');
    expect(out).not.toContain('a.test.ts');
  });

  it('honors the env override', () => {
    const { code, lines } = run(['300', 'r.json'], { FACTORY_TEST_BUDGET_SECONDS: '1' });
    expect(code).toBe(0);
    expect(lines[0]).toMatch(/^test-budget: WARNING/);
  });

  it.each([
    [
      'readFile throws',
      () => {
        throw new Error('ENOENT');
      },
    ],
    ['invalid JSON', () => 'not json'],
  ])('notes missing durations when over budget and %s', (_name, readFile) => {
    const { code, lines } = run(['500', 'r.json'], {}, readFile);
    expect(code).toBe(0);
    expect(lines[0]).toMatch(/^test-budget: WARNING/);
    expect(lines[1]).toBe('test-budget: no per-file durations in r.json');
  });

  it.each([[[]], [['abc']], [['-1']]])('skips the check for invalid elapsed %j', (argv) => {
    const { code, lines } = run(argv, {});
    expect(code).toBe(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('no valid test-step duration');
  });

  it('logs the note first for an invalid env override, then evaluates against 450', () => {
    const { code, lines } = run(['500', 'r.json'], { FACTORY_TEST_BUDGET_SECONDS: 'abc' });
    expect(code).toBe(0);
    expect(lines[0]).toContain("ignoring FACTORY_TEST_BUDGET_SECONDS='abc'");
    expect(lines[1]).toMatch(/^test-budget: WARNING.*450s/);
  });

  it('returns 1 with a FAIL line and the slowest files when over budget in CI', () => {
    const { code, lines } = run(['500', 'r.json'], { CI: 'true' });
    const out = lines.join('\n');
    expect(code).toBe(1);
    expect(lines[0]).toMatch(/^test-budget: FAIL/);
    expect(lines[0]).toContain('500s');
    expect(lines[0]).toContain('450s');
    expect(out).toContain('Slowest 5 test files:');
    expect(out).toContain('b.test.ts');
    expect(out).toContain('7.00s');
    expect(out).not.toContain('a.test.ts');
  });

  it('prints PASS and returns 0 when within budget in CI', () => {
    const { code, lines } = run(['300', 'r.json'], { CI: 'true' });
    expect(code).toBe(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^test-budget: PASS/);
  });

  it('returns 1 and notes missing durations when over budget in CI without a report', () => {
    const { code, lines } = run(['500', 'r.json'], { CI: 'true' }, () => {
      throw new Error('ENOENT');
    });
    expect(code).toBe(1);
    expect(lines[0]).toMatch(/^test-budget: FAIL/);
    expect(lines[1]).toBe('test-budget: no per-file durations in r.json');
  });

  it("still only warns when CI is 'false'", () => {
    const { code, lines } = run(['500', 'r.json'], { CI: 'false' });
    expect(code).toBe(0);
    expect(lines[0]).toMatch(/^test-budget: WARNING/);
  });

  it('skips an invalid elapsed in CI with exit 0', () => {
    const { code, lines } = run([], { CI: 'true' });
    expect(code).toBe(0);
    expect(lines[0]).toContain('no valid test-step duration');
  });
});
