import { describe, expect, it } from 'vitest';

import type { FactoryConfig } from '../config/index.js';
import { HarnessError } from '../harness/index.js';
import {
  buildDarwinProfile,
  detectSandboxRuntime,
  resolveSandboxPolicy,
  sandboxEventFromError,
  wrapCommandInSandbox,
} from './index.js';

const defaultSandboxCfg: FactoryConfig['sandbox'] = {
  enabled: true,
  network: { allow: ['api.anthropic.com', 'github.com'] },
  resources: { cpuMs: 300_000, memMb: 4096 },
};

describe('detectSandboxRuntime', () => {
  it('picks sandbox-exec on darwin when it is on PATH', () => {
    expect(detectSandboxRuntime('darwin', () => true)).toBe('sandbox-exec');
  });

  it('falls back to none on darwin without sandbox-exec', () => {
    expect(detectSandboxRuntime('darwin', () => false)).toBe('none');
  });

  it('picks firejail on linux when it is on PATH', () => {
    expect(detectSandboxRuntime('linux', () => true)).toBe('firejail');
  });

  it('falls back to none on linux without firejail', () => {
    expect(detectSandboxRuntime('linux', () => false)).toBe('none');
  });

  it('is none on win32 regardless of probe result', () => {
    expect(detectSandboxRuntime('win32', () => true)).toBe('none');
  });
});

describe('resolveSandboxPolicy', () => {
  const baseOpts = {
    worktree: '/tmp/some-worktree',
    repoRoot: '/tmp/some-repo',
    platform: 'linux' as NodeJS.Platform,
    isAvailable: () => false,
    homedir: '/home/factory',
    tmpdir: '/tmp',
  };

  it('returns undefined when cliDisabled is set', () => {
    expect(resolveSandboxPolicy(defaultSandboxCfg, { ...baseOpts, cliDisabled: true })).toBeUndefined();
  });

  it('returns undefined when FACTORY_SANDBOX=0', () => {
    expect(resolveSandboxPolicy(defaultSandboxCfg, { ...baseOpts, env: { FACTORY_SANDBOX: '0' } })).toBeUndefined();
  });

  it('returns undefined when config disables the sandbox', () => {
    const cfg: FactoryConfig['sandbox'] = { ...defaultSandboxCfg, enabled: false };
    expect(resolveSandboxPolicy(cfg, { ...baseOpts, env: {} })).toBeUndefined();
  });

  it('FACTORY_SANDBOX=1 overrides a config-off sandbox', () => {
    const cfg: FactoryConfig['sandbox'] = { ...defaultSandboxCfg, enabled: false };
    const policy = resolveSandboxPolicy(cfg, { ...baseOpts, env: { FACTORY_SANDBOX: '1' } });
    expect(policy).toBeDefined();
  });

  it('FACTORY_SANDBOX=1 does not override an explicit --no-sandbox', () => {
    const policy = resolveSandboxPolicy(defaultSandboxCfg, {
      ...baseOpts,
      cliDisabled: true,
      env: { FACTORY_SANDBOX: '1' },
    });
    expect(policy).toBeUndefined();
  });

  it('populates allowHosts/cpuMs/memMb from config defaults', () => {
    const policy = resolveSandboxPolicy(defaultSandboxCfg, { ...baseOpts, env: {} });
    expect(policy?.allowHosts).toEqual(['api.anthropic.com', 'github.com']);
    expect(policy?.cpuMs).toBe(300_000);
    expect(policy?.memMb).toBe(4096);
  });

  it('includes worktree, repo .git, tmpdir, ~/.claude, and ~/.codex in writablePaths', () => {
    const policy = resolveSandboxPolicy(defaultSandboxCfg, { ...baseOpts, env: {} });
    expect(policy?.writablePaths).toContain('/tmp/some-worktree');
    expect(policy?.writablePaths).toContain('/tmp/some-repo/.git');
    expect(policy?.writablePaths).toContain('/tmp');
    expect(policy?.writablePaths).toContain('/home/factory/.claude');
    expect(policy?.writablePaths).toContain('/home/factory/.codex');
  });

  it('dedupes writablePaths', () => {
    const policy = resolveSandboxPolicy(defaultSandboxCfg, { ...baseOpts, tmpdir: '/tmp', env: {} });
    const count = policy?.writablePaths.filter((p) => p === '/tmp').length;
    expect(count).toBe(1);
  });

  it('detects the runtime using the injected platform/isAvailable probes', () => {
    const policy = resolveSandboxPolicy(defaultSandboxCfg, {
      ...baseOpts,
      platform: 'linux',
      isAvailable: (cmd) => cmd === 'firejail',
      env: {},
    });
    expect(policy?.runtime).toBe('firejail');
  });
});

describe('buildDarwinProfile', () => {
  const policy = {
    runtime: 'sandbox-exec' as const,
    worktree: '/tmp/worktree',
    writablePaths: ['/tmp/worktree', '/tmp/repo/.git'],
    allowHosts: [] as string[],
    cpuMs: 300_000,
    memMb: 4096,
  };

  it('denies file-write* by default', () => {
    expect(buildDarwinProfile(policy)).toContain('(deny file-write*)');
  });

  it('allows a subpath rule for the worktree', () => {
    expect(buildDarwinProfile(policy)).toContain('(subpath "/tmp/worktree")');
  });

  it('denies network-outbound when allowHosts is empty', () => {
    expect(buildDarwinProfile(policy)).toContain('(deny network-outbound)');
  });

  it('does not deny network-outbound when allowHosts is non-empty', () => {
    const withAllow = { ...policy, allowHosts: ['api.anthropic.com'] };
    expect(buildDarwinProfile(withAllow)).not.toContain('(deny network-outbound)');
  });

  it('escapes quotes and backslashes in paths', () => {
    const withQuote = { ...policy, writablePaths: ['/tmp/we"ird\\path'] };
    expect(buildDarwinProfile(withQuote)).toContain('"/tmp/we\\"ird\\\\path"');
  });
});

describe('wrapCommandInSandbox', () => {
  const basePolicy = {
    worktree: '/tmp/worktree',
    writablePaths: ['/tmp/worktree'],
    allowHosts: [] as string[],
    cpuMs: 300_000,
    memMb: 4096,
  };

  it('returns the command unchanged when runtime is none', () => {
    const policy = { ...basePolicy, runtime: 'none' as const };
    expect(wrapCommandInSandbox('echo hi', policy)).toBe('echo hi');
  });

  it('wraps with sandbox-exec -p and an inner sh -c with the ulimit and original cmd', () => {
    const policy = { ...basePolicy, runtime: 'sandbox-exec' as const };
    const wrapped = wrapCommandInSandbox('echo hi', policy);
    expect(wrapped.startsWith('sandbox-exec -p ')).toBe(true);
    expect(wrapped).toContain('/bin/sh -c');
    expect(wrapped).toContain('ulimit -t 300');
    expect(wrapped).toContain('echo hi');
  });

  it('wraps with firejail read-only root and read-write per writable path', () => {
    const policy = { ...basePolicy, runtime: 'firejail' as const };
    const wrapped = wrapCommandInSandbox('echo hi', policy);
    expect(wrapped).toContain('--read-only=/');
    expect(wrapped).toContain(`--read-write='${policy.writablePaths[0]}'`);
    expect(wrapped).toContain('ulimit -t 300 -v 4194304');
  });

  it('denies network with --net=none when allowHosts is empty (firejail)', () => {
    const policy = { ...basePolicy, runtime: 'firejail' as const, allowHosts: [] };
    expect(wrapCommandInSandbox('echo hi', policy)).toContain('--net=none');
  });

  it('leaves network open (no --net=none) when allowHosts is non-empty (firejail)', () => {
    const policy = { ...basePolicy, runtime: 'firejail' as const, allowHosts: ['api.anthropic.com'] };
    expect(wrapCommandInSandbox('echo hi', policy)).not.toContain('--net=none');
  });

  it('survives a command containing input redirection inside the sh -c string', () => {
    const policy = { ...basePolicy, runtime: 'sandbox-exec' as const };
    const cmd = 'codex exec -o /tmp/out - < /tmp/prompt';
    const wrapped = wrapCommandInSandbox(cmd, policy);
    expect(wrapped).toContain(cmd);
  });
});

describe('sandboxEventFromError', () => {
  it('classifies SIGXCPU as resource_limit', () => {
    const err = Object.assign(new Error('killed'), { signal: 'SIGXCPU' });
    expect(sandboxEventFromError(err)).toMatchObject({ type: 'resource_limit' });
  });

  it('classifies "cpu time limit exceeded" stderr as resource_limit', () => {
    const err = Object.assign(new Error('boom'), { stderr: 'Cpu time limit exceeded' });
    expect(sandboxEventFromError(err)).toMatchObject({ type: 'resource_limit' });
  });

  it('classifies "Operation not permitted" stderr as sandbox_violation', () => {
    const err = Object.assign(new Error('boom'), { stderr: 'Operation not permitted' });
    expect(sandboxEventFromError(err)).toMatchObject({ type: 'sandbox_violation' });
  });

  it('classifies a HarnessError with sandbox-deny stderr in details as sandbox_violation', () => {
    const err = new HarnessError('boom', 'error', { stderr: 'sandbox-exec: deny(1) file-write-create' });
    expect(sandboxEventFromError(err)).toMatchObject({ type: 'sandbox_violation' });
  });

  it('classifies a HarnessError with SIGXCPU signal in details as resource_limit', () => {
    const err = new HarnessError('boom', 'timeout', { signal: 'SIGXCPU' });
    expect(sandboxEventFromError(err)).toMatchObject({ type: 'resource_limit' });
  });

  it('returns undefined for an unrelated error', () => {
    const err = Object.assign(new Error('boom'), { stderr: 'rate limit exceeded' });
    expect(sandboxEventFromError(err)).toBeUndefined();
  });

  it('returns undefined for a non-object error', () => {
    expect(sandboxEventFromError('just a string')).toBeUndefined();
  });
});
