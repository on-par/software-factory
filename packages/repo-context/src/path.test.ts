import { describe, expect, it } from 'vitest';

import { compareByPath, joinRepoPath, normalizeRepoPath } from './path.js';

describe('normalizeRepoPath', () => {
  it.each(['', '.', '/', './'])('maps %j to the repo root', (input) => {
    expect(normalizeRepoPath(input)).toBe('');
  });

  it.each(['./a/b', '/a/b', 'a//b', 'a/b/', '  a/b  '])('normalizes %j to a/b', (input) => {
    expect(normalizeRepoPath(input)).toBe('a/b');
  });

  it('collapses an internal ./ segment', () => {
    expect(normalizeRepoPath('a/./b')).toBe('a/b');
  });

  it.each(['../secrets', 'a/../../b', '..'])('returns undefined for an escaping path %j', (input) => {
    expect(normalizeRepoPath(input)).toBeUndefined();
  });
});

describe('joinRepoPath', () => {
  it('returns name when base is the repo root', () => {
    expect(joinRepoPath('', 'x')).toBe('x');
  });

  it('joins base and name with a slash', () => {
    expect(joinRepoPath('a', 'b')).toBe('a/b');
  });
});

describe('compareByPath', () => {
  it('orders by code point, not locale', () => {
    const sorted = [{ path: 'b' }, { path: 'B' }, { path: 'a' }].sort(compareByPath);
    expect(sorted.map((e) => e.path)).toEqual(['B', 'a', 'b']);
  });

  it('returns 0 for equal paths', () => {
    expect(compareByPath({ path: 'x' }, { path: 'x' })).toBe(0);
  });
});
