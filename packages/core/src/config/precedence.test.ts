import { describe, expect, it, vi } from 'vitest';

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
    const later = vi.fn(() => 2);
    resolvePrecedence<number>(
      [
        { source: 'repo', read: () => 1 },
        { source: 'env', read: later },
      ],
      0,
    );
    expect(later).not.toHaveBeenCalled();
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
