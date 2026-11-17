import { describe, expect, it } from 'vitest';

import { extractFailedTestEvidence, parseCommandCounts } from './command-output.js';

describe('parseCommandCounts', () => {
  it.each([
    ['      Tests  2 failed | 300 passed (302)', { format: 'vitest', line: '2 failed | 300 passed', failed: 2 }],
    ['src/a.ts(1,5): error TS2322: bad.\nFound 3 errors in 3 files.', { format: 'tsc', line: '3 errors', errors: 3 }],
    ['src/a.ts(1,5): error TS2322: bad.', { format: 'tsc', line: '1 error', errors: 1 }],
    ['✖ 4 problems (4 errors, 0 warnings)', { format: 'eslint', problems: 4, errors: 4, warnings: 0 }],
  ])('reads the counts in %j', (output, expected) => {
    expect(parseCommandCounts(output)).toMatchObject(expected);
  });

  it('reads jest and pytest summary lines', () => {
    expect(parseCommandCounts('Tests:       2 failed, 1 skipped, 300 passed, 303 total')?.line).toBe(
      '2 failed | 1 skipped | 300 passed',
    );
    expect(parseCommandCounts('=== 1 failed, 4 passed in 0.12s ===')).toMatchObject({
      format: 'pytest',
      line: '1 failed | 4 passed',
      failed: 1,
      passed: 4,
    });
  });

  it('returns null counts for plain text', () => {
    expect(parseCommandCounts('hello world')).toBeNull();
  });
});

describe('extractFailedTestEvidence', () => {
  it('quotes the vitest FAIL line over an earlier suite summary line', () => {
    const output = [
      ' ❯ src/a.test.ts (2 tests | 1 failed) 12ms',
      '   × adds 3ms',
      '',
      ' FAIL  src/a.test.ts > adds',
      'AssertionError: boom',
    ].join('\n');
    expect(extractFailedTestEvidence(output)).toBe('FAIL  src/a.test.ts > adds\nAssertionError: boom');
  });
});
