import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { FactoryConfig } from '../config/index.js';
import { createTempDirs } from '../harness/temp-dir.js';
import { buildDarwinProfile, resolveSandboxPolicy } from './index.js';

const tempDirs = createTempDirs();
afterEach(() => tempDirs.cleanup());

const defaultSandboxCfg: FactoryConfig['sandbox'] = {
  enabled: true,
  runtime: 'auto',
  network: { allow: ['api.anthropic.com', 'github.com'] },
  resources: { cpuMs: 300_000, memMb: 4096 },
  docker: { rolloutPercent: 0 },
};

function worktreeWith(...files: string[]): string {
  const dir = tempDirs.makeSync('sandbox-dotnet-writable-');
  for (const f of files) {
    mkdirSync(join(dir, f, '..'), { recursive: true });
    writeFileSync(join(dir, f), '');
  }
  return dir;
}

function resolvePolicy(worktree: string, writablePaths?: string[], platform: NodeJS.Platform = 'linux') {
  return resolveSandboxPolicy(
    { ...defaultSandboxCfg, writablePaths },
    {
      worktree,
      repoRoot: '/tmp/some-repo',
      platform,
      isAvailable: () => false,
      homedir: '/home/factory',
      tmpdir: '/tmp',
      env: {},
    },
  );
}

describe('dotnet ecosystem writable defaults (#3567)', () => {
  it('a dotnet worktree gets the NuGet and dotnet caches as writable paths', () => {
    const policy = resolvePolicy(worktreeWith('App.csproj'));
    expect(policy?.writablePaths).toContain('/home/factory/.nuget');
    expect(policy?.writablePaths).toContain('/home/factory/.dotnet');
    expect(policy?.configuredWritablePaths).toEqual([]);
  });

  it('a nested src/App/App.csproj worktree gets both caches', () => {
    const policy = resolvePolicy(worktreeWith('src/App/App.csproj'));
    expect(policy?.writablePaths).toContain('/home/factory/.nuget');
    expect(policy?.writablePaths).toContain('/home/factory/.dotnet');
  });

  it('a Node-only worktree gets neither the NuGet nor the dotnet cache', () => {
    const policy = resolvePolicy(worktreeWith('package.json'));
    expect(policy?.writablePaths).not.toContain('/home/factory/.nuget');
    expect(policy?.writablePaths).not.toContain('/home/factory/.dotnet');
  });

  it('a dotnet worktree with ~/.nuget configured lists it once and still adds ~/.dotnet', () => {
    const policy = resolvePolicy(worktreeWith('App.csproj'), ['~/.nuget']);
    const paths = policy?.writablePaths ?? [];
    expect(paths.filter((p) => p === '/home/factory/.nuget')).toHaveLength(1);
    expect(paths.filter((p) => p === '/home/factory/.dotnet')).toHaveLength(1);
    expect(policy?.configuredWritablePaths).toEqual(['/home/factory/.nuget']);
  });

  it('the darwin profile writes subpath rules for both caches', () => {
    const policy = resolvePolicy(worktreeWith('App.csproj'), undefined, 'darwin');
    const profile = policy ? buildDarwinProfile(policy) : '';
    expect(profile).toContain('(allow file-write* (subpath "/home/factory/.nuget"))');
    expect(profile).toContain('(allow file-write* (subpath "/home/factory/.dotnet"))');
  });
});
