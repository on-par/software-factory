import { describe, expect, it } from 'vitest';

import { resolvePrecedence } from './precedence.js';

describe('resolvePrecedence', () => {
  it('returns the first candidate that hits, with its source', () => {
    expect(
      resolvePrecedence<number>(
        [
          { source: 'flag', read: () => 1 },
          { source: 'repo', read: () => 2 },
        ],
        0,
      ),
    ).toEqual({ value: 1, source: 'flag' });
  });

  it('falls through an undefined read', () => {
    expect(
      resolvePrecedence<number>(
        [
          { source: 'flag', read: () => undefined },
          { source: 'repo', read: () => 2 },
        ],
        0,
      ),
    ).toEqual({ value: 2, source: 'repo' });
  });

  it('treats falsy non-undefined values as a hit', () => {
    expect(resolvePrecedence<boolean>([{ source: 'repo', read: () => false }], true)).toEqual({
      value: false,
      source: 'repo',
    });
  });

  it('never calls a later read once an earlier one hits', () => {
    const reads: string[] = [];
    const result = resolvePrecedence<number>(
      [
        {
          source: 'repo',
          read: () => {
            reads.push('repo');
            return 1;
          },
        },
        {
          source: 'env',
          read: () => {
            reads.push('env');
            return 2;
          },
        },
      ],
      0,
    );
    expect(result).toEqual({ value: 1, source: 'repo' });
    expect(reads).toEqual(['repo']);
  });

  it('returns the fallback as source default when nothing hits', () => {
    expect(resolvePrecedence<number>([{ source: 'env', read: () => undefined }], 7)).toEqual({
      value: 7,
      source: 'default',
    });
    expect(resolvePrecedence<number>([], 7)).toEqual({ value: 7, source: 'default' });
  });

  it('propagates a throwing read', () => {
    expect(() =>
      resolvePrecedence<number>(
        [
          {
            source: 'env',
            read: () => {
              throw new Error('bad env');
            },
          },
        ],
        0,
      ),
    ).toThrow('bad env');
  });
});
