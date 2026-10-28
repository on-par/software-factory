import { describe, expect, it } from 'vitest';
import { parseFailToPassSelector, resolveEvidenceTestRunner, selectorArgs } from './evidence-selector.js';

describe('parseFailToPassSelector', () => {
  it('parses a file with quoted names and rejects prose', () => {
    expect(parseFailToPassSelector('src/a.test.ts "does x" "does y"')).toEqual({
      file: 'src/a.test.ts',
      names: ['does x', 'does y'],
    });
    expect(parseFailToPassSelector('src/a.test.ts — "does x"')).toEqual({ file: 'src/a.test.ts', names: ['does x'] });
    expect(parseFailToPassSelector('src/a.test.ts: "x"')).toEqual({ file: 'src/a.test.ts', names: ['x'] });
    expect(parseFailToPassSelector('tests/test_a.py::test_b')).toEqual({ file: 'tests/test_a.py', names: ['test_b'] });
    expect(parseFailToPassSelector('src/a.test.ts')).toEqual({ file: 'src/a.test.ts', names: [] });
    expect(parseFailToPassSelector('src/a.test.ts "x" \'x\'')).toEqual({ file: 'src/a.test.ts', names: ['x'] });
    for (const bad of [
      'src/a.test.ts proves the fix',
      'src/a.test.ts --run',
      'the new test in evidence-plan',
      'src/a.ts "x"',
      '-t x',
      'src/a.test.ts "x',
      'src/a.test.ts ""',
      'tests/test_a.py::',
      'src/a.test.ts "x"y',
      '',
    ]) {
      expect(parseFailToPassSelector(bad)).toBeNull();
    }
  });
});

describe('resolveEvidenceTestRunner', () => {
  it('detects the runner from the test command', () => {
    expect(resolveEvidenceTestRunner(new Map([['test', ['npx', 'vitest', 'run']]]), {})).toBe('vitest');
    const npmTest = new Map([['test', ['npm', 'run', 'test']]]);
    expect(resolveEvidenceTestRunner(npmTest, { scripts: { test: 'vitest run' } })).toBe('vitest');
    expect(resolveEvidenceTestRunner(npmTest, { scripts: { test: 'bash scripts/test.sh' } })).toBeNull();
    expect(resolveEvidenceTestRunner(npmTest, { scripts: { test: 'vitest > out' } })).toBeNull();
    expect(resolveEvidenceTestRunner(npmTest, { scripts: { test: 1 } })).toBeNull();
    expect(resolveEvidenceTestRunner(npmTest, { scripts: [] })).toBeNull();
    expect(resolveEvidenceTestRunner(npmTest, 'nope')).toBeNull();
    expect(resolveEvidenceTestRunner(new Map([['test', ['jest']]]), {})).toBe('jest');
    expect(resolveEvidenceTestRunner(new Map([['test', ['python', '-m', 'pytest']]]), {})).toBe('pytest');
    expect(resolveEvidenceTestRunner(new Map([['test', ['bash', 'scripts/test.sh']]]), {})).toBeNull();
    expect(resolveEvidenceTestRunner(new Map(), {})).toBeNull();
  });
});

describe('selectorArgs', () => {
  it('maps a selector to runner filter flags', () => {
    expect(selectorArgs({ file: 'a.test.ts', names: ['f(x)', 'y'] }, 'vitest')).toEqual([
      'a.test.ts',
      '-t',
      'f\\(x\\)|y',
    ]);
    expect(selectorArgs({ file: 'a.test.ts', names: [] }, 'jest')).toEqual(['a.test.ts']);
    expect(selectorArgs({ file: 't/test_a.py', names: ['a', 'b'] }, 'pytest')).toEqual([
      't/test_a.py::a',
      't/test_a.py::b',
    ]);
    expect(selectorArgs({ file: 't/test_a.py', names: [] }, 'pytest')).toEqual(['t/test_a.py']);
  });
});
