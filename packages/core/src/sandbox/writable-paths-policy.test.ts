import { describe, expect, it } from 'vitest';

import type { FactoryConfig } from '../config/index.js';
import { buildDarwinProfile, resolveSandboxPolicy } from './index.js';

const defaultSandboxCfg: FactoryConfig['sandbox'] = {
  enabled: true,
  runtime: 'auto',
  network: { allow: ['api.anthropic.com', 'github.com'] },
  resources: { cpuMs: 300_000, memMb: 4096 },
  docker: { rolloutPercent: 0 },
};

const baseOpts = {
  worktree: '/tmp/some-worktree',
  repoRoot: '/tmp/some-repo',
  platform: 'linux' as NodeJS.Platform,
  isAvailable: () => false,
  homedir: '/home/factory',
  tmpdir: '/tmp',
};

describe('sandbox.writablePaths (#3454)', () => {
  const withPaths = (writablePaths?: string[]): FactoryConfig['sandbox'] => ({ ...defaultSandboxCfg, writablePaths });
  const run = (cfg: FactoryConfig['sandbox'], platform: NodeJS.Platform = 'linux') =>
    resolveSandboxPolicy(cfg, { ...baseOpts, platform, env: {} });

  it('adds configured sandbox.writablePaths after the built-in paths', () => {
    const base = run(defaultSandboxCfg)?.writablePaths ?? [];
    const policy = run(withPaths(['~/.nuget']));
    expect(policy?.writablePaths).toEqual([...base, '/home/factory/.nuget']);
    expect(policy?.configuredWritablePaths).toEqual(['/home/factory/.nuget']);
  });

  it('leaves writablePaths unchanged when sandbox.writablePaths is unset or empty', () => {
    const unset = run(defaultSandboxCfg)?.writablePaths;
    expect(run(withPaths([]))?.writablePaths).toEqual(unset);
    expect(unset).toEqual([
      '/tmp/some-worktree',
      '/tmp/some-repo/.git',
      '/tmp',
      '/home/factory/.claude',
      '/home/factory/.codex',
      '/home/factory/.openclaw',
      '/home/factory/.npm',
      '/home/factory/.cache',
      '/home/factory/.config',
      '/home/factory/.local',
    ]);
  });

  it('dedupes a configured writable path that matches a built-in', () => {
    const paths = run(withPaths(['~/.npm']))?.writablePaths ?? [];
    expect(paths.filter((p) => p === '/home/factory/.npm')).toHaveLength(1);
  });

  it('renders a subpath write rule for a configured writable path', () => {
    const policy = run(withPaths(['~/.nuget']), 'darwin');
    expect(buildDarwinProfile(policy!)).toContain('(allow file-write* (subpath "/home/factory/.nuget"))');
  });

  it('throws naming an entry that contains the primary repo', () => {
    expect(() => run(withPaths(['/tmp']))).toThrow(/"\/tmp".*primary repo checkout/);
  });
});
