import { describe, expect, it } from 'vitest';

import { resolveConfiguredWritablePaths, writablePathError } from './writable-paths.js';

const opts = { home: '/home/factory', repoRoot: '/home/factory/repos/app' };

describe('resolveConfiguredWritablePaths', () => {
  it('expands ~/, keeps absolute paths and collapses duplicates', () => {
    expect(resolveConfiguredWritablePaths(['~/.nuget', '/opt/cache', '/home/factory/.nuget'], opts)).toEqual([
      '/home/factory/.nuget',
      '/opt/cache',
    ]);
    expect(resolveConfiguredWritablePaths(undefined, opts)).toEqual([]);
  });

  it('rejects relative, root, home and repo-containing entries naming the entry', () => {
    for (const entry of ['foo', './x', '', '/', '~', '~/', '/home/factory', '/home/factory/repos', opts.repoRoot]) {
      expect(() => resolveConfiguredWritablePaths([entry], opts)).toThrow(`"${entry}"`);
    }
  });

  it('allows a sibling of the repo and a path inside it', () => {
    expect(writablePathError('/home/factory/repos/other', opts)).toBeUndefined();
    expect(writablePathError('/home/factory/repos/app/bin', opts)).toBeUndefined();
  });

  it('skips the repo rule when no repoRoot is given', () => {
    expect(writablePathError('/home/factory/repos', { home: opts.home })).toBeUndefined();
    expect(writablePathError('foo', { home: opts.home })).toMatch(/absolute/);
  });
});
