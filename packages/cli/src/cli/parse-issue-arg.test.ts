import { describe, expect, it } from 'vitest';
import { CliExitError, parseIssueArg } from './index.js';

describe('parseIssueArg', () => {
  it('returns the parsed number for a valid issue argument', () => {
    expect(parseIssueArg('123')).toBe(123);
  });

  it('trims surrounding whitespace before parsing', () => {
    expect(parseIssueArg(' 42 ')).toBe(42);
  });

  it('accepts Number.MAX_SAFE_INTEGER unchanged', () => {
    expect(parseIssueArg('9007199254740991')).toBe(Number.MAX_SAFE_INTEGER);
  });

  it.each([
    'abc',
    '',
    '12abc',
    '1.5',
    '-3',
    '0',
    '#123',
    '9007199254740992',
    '9007199254740993',
    '99999999999999999999',
  ])("throws CliExitError(2) naming the invalid argument for '%s'", (raw) => {
    expect(() => parseIssueArg(raw)).toThrowError(CliExitError);
    try {
      parseIssueArg(raw);
      expect.fail('expected parseIssueArg to throw');
    } catch (err) {
      expect(err).toMatchObject({
        name: 'CliExitError',
        code: 2,
        message: expect.stringContaining(`'${raw}'`),
      });
      expect((err as Error).message).toContain('expected a positive integer issue number');
    }
  });
});
