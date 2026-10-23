import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';

import { resolveConfiguredWritablePaths, resolveEcosystemWritablePaths, writablePathError } from './writable-paths.js';

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

describe('resolveEcosystemWritablePaths (#3567)', () => {
  const opts = { home: '/home/factory', repoRoot: '/tmp/some-repo' };
  const tempDirs = createTempDirs();
  afterEach(() => tempDirs.cleanup());

  it('returns the NuGet and dotnet caches for a dotnet directory', () => {
    const dir = tempDirs.makeSync('eco-writable-');
    writeFileSync(join(dir, 'App.csproj'), '');
    expect(resolveEcosystemWritablePaths(dir, opts)).toEqual(['/home/factory/.nuget', '/home/factory/.dotnet']);
  });

  it('returns nothing when no ecosystem is detected', () => {
    expect(resolveEcosystemWritablePaths('', opts)).toEqual([]);
  });
});
