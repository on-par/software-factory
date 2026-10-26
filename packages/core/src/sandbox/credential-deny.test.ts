import { describe, expect, it } from 'vitest';

import type { FactoryConfig } from '../config/index.js';
import { buildDarwinProfile, resolveSandboxPolicy, wrapCommandInSandbox } from './index.js';
import type { SandboxPolicy } from './index.js';

const cfg: FactoryConfig['sandbox'] = {
  enabled: true,
  runtime: 'auto',
  network: { allow: ['api.anthropic.com'] },
  resources: { cpuMs: 300_000, memMb: 4096 },
  docker: { rolloutPercent: 0 },
};

const DENIED = ['/home/factory/.ssh', '/home/factory/.aws', '/home/factory/.gnupg', '/home/factory/.config/gh'];

function resolveFor(platform: NodeJS.Platform, runtime: string, env: NodeJS.ProcessEnv = {}): SandboxPolicy {
  const policy = resolveSandboxPolicy(cfg, {
    worktree: '/tmp/some-worktree',
    repoRoot: '/tmp/some-repo',
    platform,
    isAvailable: () => false,
    homedir: '/home/factory',
    tmpdir: '/tmp',
    env: { FACTORY_SANDBOX_RUNTIME: runtime, ...env },
  });
  if (!policy) throw new Error('expected a sandbox policy');
  return policy;
}

describe('host credential dir denial (#1586)', () => {
  it('resolveSandboxPolicy denies the four credential dirs but no harness auth path (~/.claude, ~/.claude.json, CLAUDE_CONFIG_DIR, ~/.codex, ~/Library/Keychains) (#1586)', () => {
    const env = { CLAUDE_CONFIG_DIR: '/home/factory/.claude-work' };
    const darwin = resolveFor('darwin', 'sandbox-exec', env);
    expect(darwin.deniedReadPaths).toEqual(DENIED);
    expect(resolveFor('linux', 'firejail', env).deniedReadPaths).toEqual(DENIED);
    const authPaths = [
      '/home/factory/.claude',
      '/home/factory/.claude.json',
      '/home/factory/.claude-work',
      '/home/factory/.codex',
      '/home/factory/Library/Keychains',
    ];
    for (const auth of authPaths) {
      for (const d of darwin.deniedReadPaths ?? []) {
        expect(auth === d || auth.startsWith(`${d}/`)).toBe(false);
      }
    }
  });

  it('buildDarwinProfile denies file-read* for every host credential dir of a resolved policy (#1586)', () => {
    const profile = buildDarwinProfile(resolveFor('darwin', 'sandbox-exec'));
    const allowAt = profile.indexOf('(allow default)');
    expect(allowAt).toBeGreaterThanOrEqual(0);
    for (const d of DENIED) {
      const rule = `(deny file-read* (subpath "${d}"))`;
      expect(profile).toContain(rule);
      expect(profile.indexOf(rule)).toBeGreaterThan(allowAt);
    }
  });

  it('buildDarwinProfile renders no file-read* rule without deniedReadPaths and escapes via sbplPath', () => {
    const policy = { ...resolveFor('darwin', 'sandbox-exec'), deniedReadPaths: undefined };
    expect(buildDarwinProfile(policy)).not.toContain('file-read*');
    const quoted = buildDarwinProfile({ ...policy, deniedReadPaths: ['/home/we"ird'] });
    expect(quoted).toContain('(deny file-read* (subpath "/home/we\\"ird"))');
  });

  it('wrapCommandInSandbox blacklists every host credential dir after the read-write flags (firejail, #1586)', () => {
    const wrapped = wrapCommandInSandbox('echo hi', resolveFor('linux', 'firejail'));
    for (const d of DENIED) expect(wrapped).toContain(`--blacklist='${d}'`);
    expect(wrapped.lastIndexOf('--read-write=')).toBeLessThan(wrapped.indexOf('--blacklist='));
  });

  it('wrapCommandInSandbox emits no --blacklist without deniedReadPaths and embeds deny rules for sandbox-exec', () => {
    const fj = { ...resolveFor('linux', 'firejail'), deniedReadPaths: undefined };
    expect(wrapCommandInSandbox('echo hi', fj)).not.toContain('--blacklist');
    const exec = wrapCommandInSandbox('echo hi', resolveFor('darwin', 'sandbox-exec'));
    expect(exec).toContain('sandbox-exec -p');
    expect(exec).toContain('(deny file-read* (subpath "/home/factory/.ssh"))');
  });
});
