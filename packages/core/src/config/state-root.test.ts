import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveStateRoot } from './state-root.js';

const opts = { repoRoot: '/repo', home: '/home/u', resolveSlug: () => 'o/n' };

describe('resolveStateRoot', () => {
  it('returns undefined for unset and blank values', () => {
    expect(resolveStateRoot(undefined, opts)).toBeUndefined();
    expect(resolveStateRoot('', opts)).toBeUndefined();
    expect(resolveStateRoot('   ', opts)).toBeUndefined();
  });

  it.each(['auto', 'AUTO', ' auto '])('resolves %j to <home>/.factory/<owner>/<name>', (v) => {
    expect(resolveStateRoot(v, opts)).toBe(join('/home/u', '.factory', 'o', 'n'));
  });

  it('throws for auto without a parseable origin', () => {
    expect(() => resolveStateRoot('auto', { ...opts, resolveSlug: () => null })).toThrow(/needs a git origin remote/);
  });

  it('expands ~ and ~/x', () => {
    expect(resolveStateRoot('~', opts)).toBe('/home/u');
    expect(resolveStateRoot('~/x', opts)).toBe(join('/home/u', 'x'));
  });

  it('keeps an absolute path', () => {
    expect(resolveStateRoot('/abs/path', opts)).toBe('/abs/path');
  });

  it('rejects relative paths', () => {
    expect(() => resolveStateRoot('relative/path', opts)).toThrow(/must be an absolute path/);
    expect(() => resolveStateRoot('./x', opts)).toThrow(/must be an absolute path/);
  });
});
