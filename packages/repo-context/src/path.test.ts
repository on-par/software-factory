import { describe, expect, it } from 'vitest';

import { joinRepoPath, normalizeRepoPath } from './path.js';

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
