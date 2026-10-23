import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTempDirs } from '../harness/temp-dir.js';
import { checkCommandArgv } from './checks-section.js';
import { adaptV1ToV2, loadRepoConfig, RepoFactoryConfigV1Schema, RepoFactoryConfigV2Schema } from './repo.js';

const tmp = createTempDirs();
afterEach(() => tmp.cleanup());
function repo(config: unknown): string {
  const root = tmp.makeSync('repo-checks-');
  mkdirSync(join(root, '.factory'));
  writeFileSync(join(root, '.factory', 'config.json'), JSON.stringify(config));
  return root;
}

describe('repo checks config', () => {
  const checks = { build: 'dotnet build App.sln', test: 'pwsh ./.githooks/run-tests.ps1', lint: 'dotnet format' };

  it('accepts checks in both schemas and keeps them through V1 adaptation and loading', () => {
    expect(RepoFactoryConfigV1Schema.parse({ version: 1, checks }).checks).toEqual(checks);
    expect(RepoFactoryConfigV2Schema.parse({ version: 2, checks }).checks).toEqual(checks);
    expect(adaptV1ToV2({ version: 1, checks }).checks).toEqual(checks);
    expect(loadRepoConfig(repo({ version: 1, checks }))?.checks).toEqual(checks);
    expect(loadRepoConfig(repo({ version: 2, checks }))?.checks).toEqual(checks);
    expect(adaptV1ToV2({ version: 1 }).checks).toBeUndefined();
  });

  it('rejects unknown kinds, empty strings and commands that need a shell', () => {
    for (const bad of [
      { deploy: 'x' },
      { test: '' },
      { test: 'a | b' },
      { test: 'a && b' },
      { test: 'FOO=1 a' },
      { build: 7 },
    ]) {
      expect(RepoFactoryConfigV2Schema.safeParse({ version: 2, checks: bad }).success).toBe(false);
      expect(RepoFactoryConfigV1Schema.safeParse({ version: 1, checks: bad }).success).toBe(false);
    }
    expect(() => loadRepoConfig(repo({ version: 2, checks: { test: 'a; b' } }))).toThrow(/checks\.test/);
  });

  it('checkCommandArgv tokenizes the declared command and is null when unset', () => {
    expect(checkCommandArgv({ test: 'dotnet test "My App.sln"' }, 'test')).toEqual(['dotnet', 'test', 'My App.sln']);
    expect(checkCommandArgv({ test: 'dotnet test' }, 'lint')).toBeNull();
    expect(checkCommandArgv(null, 'build')).toBeNull();
    expect(checkCommandArgv(undefined, 'build')).toBeNull();
  });
});
