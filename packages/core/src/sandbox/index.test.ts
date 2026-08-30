import { describe, expect, it } from 'vitest';

import type { FactoryConfig } from '../config/index.js';
import { HarnessError } from '../harness/index.js';
import {
  buildDarwinProfile,
  detectSandboxRuntime,
  resolveRolloutRuntime,
  resolveSandboxPolicy,
  resolveSandboxRuntime,
  sandboxEventFromError,
  wrapCommandInSandbox,
} from './index.js';

const defaultSandboxCfg: FactoryConfig['sandbox'] = {
  enabled: true,
  runtime: 'auto',
  network: { allow: ['api.anthropic.com', 'github.com'] },
  resources: { cpuMs: 300_000, memMb: 4096 },
  docker: { rolloutPercent: 0 },
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

  it('picks docker-sandbox when opted in and sbx is on PATH', () => {
    expect(detectSandboxRuntime('linux', (c) => c === 'sbx', { includeDockerSandbox: true })).toBe('docker-sandbox');
  });

  it('opting in to docker-sandbox wins over sandbox-exec on darwin', () => {
    expect(detectSandboxRuntime('darwin', () => true, { includeDockerSandbox: true })).toBe('docker-sandbox');
  });

  it('never selects docker-sandbox when includeDockerSandbox is absent, even with sbx present', () => {
    expect(detectSandboxRuntime('darwin', () => true)).toBe('sandbox-exec');
    expect(detectSandboxRuntime('linux', (c) => c === 'sbx')).toBe('none');
  });
});

describe('resolveSandboxRuntime', () => {
  it('with no configured value and no env, matches detectSandboxRuntime for darwin/linux/win32', () => {
    expect(resolveSandboxRuntime(undefined, { platform: 'darwin', isAvailable: () => true, env: {} })).toBe(
      detectSandboxRuntime('darwin', () => true),
    );
    expect(resolveSandboxRuntime(undefined, { platform: 'linux', isAvailable: () => true, env: {} })).toBe(
      detectSandboxRuntime('linux', () => true),
    );
    expect(resolveSandboxRuntime(undefined, { platform: 'win32', isAvailable: () => true, env: {} })).toBe(
      detectSandboxRuntime('win32', () => true),
    );
  });

  it("'auto' with sbx present never resolves to docker-sandbox (AC5)", () => {
    expect(resolveSandboxRuntime('auto', { platform: 'linux', isAvailable: () => true, env: {} })).toBe('firejail');
  });

  it('an explicit runtime is honored verbatim even when its binary is unavailable', () => {
    expect(resolveSandboxRuntime('docker-sandbox', { platform: 'linux', isAvailable: () => false, env: {} })).toBe(
      'docker-sandbox',
    );
  });

  it("'none' is honored verbatim even when a runtime binary is present", () => {
    expect(resolveSandboxRuntime('none', { platform: 'darwin', isAvailable: () => true, env: {} })).toBe('none');
  });

  it('FACTORY_SANDBOX_RUNTIME overrides the config field; unset falls back to it', () => {
    expect(
      resolveSandboxRuntime('auto', {
        platform: 'darwin',
        isAvailable: () => true,
        env: { FACTORY_SANDBOX_RUNTIME: 'docker-sandbox' },
      }),
    ).toBe('docker-sandbox');
    expect(
      resolveSandboxRuntime('auto', {
        platform: 'darwin',
        isAvailable: () => true,
        env: {},
      }),
    ).toBe('sandbox-exec');
  });

  it("env 'auto' beats a configured explicit runtime, mirroring FACTORY_SANDBOX=1", () => {
    expect(
      resolveSandboxRuntime('none', {
        platform: 'linux',
        isAvailable: () => true,
        env: { FACTORY_SANDBOX_RUNTIME: 'auto' },
      }),
    ).toBe('firejail');
  });

  it('ignores unknown FACTORY_SANDBOX_RUNTIME values and falls back to the config field', () => {
    expect(
      resolveSandboxRuntime('firejail', {
        platform: 'linux',
        isAvailable: () => false,
        env: { FACTORY_SANDBOX_RUNTIME: 'bogus' },
      }),
    ).toBe('firejail');
    expect(
      resolveSandboxRuntime('firejail', {
        platform: 'linux',
        isAvailable: () => false,
        env: { FACTORY_SANDBOX_RUNTIME: '' },
      }),
    ).toBe('firejail');
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

  it('includes worktree, repo .git, tmpdir, and agent runtime state dirs in writablePaths', () => {
    const policy = resolveSandboxPolicy(defaultSandboxCfg, { ...baseOpts, env: {} });
    expect(policy?.writablePaths).toContain('/tmp/some-worktree');
    expect(policy?.writablePaths).toContain('/tmp/some-repo/.git');
    expect(policy?.writablePaths).toContain('/tmp');
    expect(policy?.writablePaths).toContain('/home/factory/.claude');
    expect(policy?.writablePaths).toContain('/home/factory/.codex');
    expect(policy?.writablePaths).toContain('/home/factory/.openclaw');
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

  it('includes ~/.claude.json in writableFilePrefixes', () => {
    const policy = resolveSandboxPolicy(defaultSandboxCfg, { ...baseOpts, env: {} });
    expect(policy?.writableFilePrefixes).toContain('/home/factory/.claude.json');
  });

  it('includes ~/Library/Keychains in writablePaths on darwin', () => {
    const policy = resolveSandboxPolicy(defaultSandboxCfg, { ...baseOpts, platform: 'darwin', env: {} });
    expect(policy?.writablePaths).toContain('/home/factory/Library/Keychains');
  });

  it('does not include ~/Library/Keychains on linux, and never grants a blanket home write', () => {
    const linuxPolicy = resolveSandboxPolicy(defaultSandboxCfg, { ...baseOpts, platform: 'linux', env: {} });
    expect(linuxPolicy?.writablePaths).not.toContain('/home/factory/Library/Keychains');
    expect(linuxPolicy?.writablePaths).not.toContain('/home/factory');

    const darwinPolicy = resolveSandboxPolicy(defaultSandboxCfg, { ...baseOpts, platform: 'darwin', env: {} });
    expect(darwinPolicy?.writablePaths).not.toContain('/home/factory');
  });

  it('honors an explicit docker-sandbox runtime from config', () => {
    const cfg: FactoryConfig['sandbox'] = { ...defaultSandboxCfg, runtime: 'docker-sandbox' };
    const policy = resolveSandboxPolicy(cfg, { ...baseOpts, env: {} });
    expect(policy?.runtime).toBe('docker-sandbox');
  });

  it('FACTORY_SANDBOX_RUNTIME=none yields a defined policy with runtime none (not sandbox-disabled)', () => {
    const policy = resolveSandboxPolicy(defaultSandboxCfg, {
      ...baseOpts,
      env: { FACTORY_SANDBOX_RUNTIME: 'none' },
    });
    expect(policy).toBeDefined();
    expect(policy?.runtime).toBe('none');
  });

  it('promotes an unpinned lane to docker-sandbox when rolloutPercent=100', () => {
    const cfg: FactoryConfig['sandbox'] = { ...defaultSandboxCfg, docker: { rolloutPercent: 100 } };
    const policy = resolveSandboxPolicy(cfg, { ...baseOpts, env: {}, laneId: 'lane-any' });
    expect(policy?.runtime).toBe('docker-sandbox');
  });

  it('leaves the normally-resolved runtime when rolloutPercent=0', () => {
    const cfg: FactoryConfig['sandbox'] = { ...defaultSandboxCfg, docker: { rolloutPercent: 0 } };
    const policy = resolveSandboxPolicy(cfg, {
      ...baseOpts,
      env: {},
      laneId: 'lane-any',
      isAvailable: (cmd) => cmd === 'firejail',
    });
    expect(policy?.runtime).toBe('firejail');
  });

  it('ignores the rollout when the runtime is pinned via config', () => {
    const cfg: FactoryConfig['sandbox'] = {
      ...defaultSandboxCfg,
      runtime: 'sandbox-exec',
      docker: { rolloutPercent: 100 },
    };
    const policy = resolveSandboxPolicy(cfg, { ...baseOpts, env: {}, laneId: 'lane-any' });
    expect(policy?.runtime).toBe('sandbox-exec');
  });

  it('ignores the rollout when FACTORY_SANDBOX_RUNTIME is set', () => {
    const cfg: FactoryConfig['sandbox'] = { ...defaultSandboxCfg, docker: { rolloutPercent: 100 } };
    const policy = resolveSandboxPolicy(cfg, {
      ...baseOpts,
      env: { FACTORY_SANDBOX_RUNTIME: 'none' },
      laneId: 'lane-any',
    });
    expect(policy?.runtime).toBe('none');
  });

  it('ignores the rollout when laneId is undefined', () => {
    const cfg: FactoryConfig['sandbox'] = { ...defaultSandboxCfg, docker: { rolloutPercent: 100 } };
    const policy = resolveSandboxPolicy(cfg, { ...baseOpts, env: {} });
    expect(policy?.runtime).toBe('none');
  });
});

describe('resolveRolloutRuntime', () => {
  it('is deterministic for the same lane ID', () => {
    expect(resolveRolloutRuntime('lane-42', 50)).toBe(resolveRolloutRuntime('lane-42', 50));
  });

  it('returns undefined for an undefined laneId', () => {
    expect(resolveRolloutRuntime(undefined, 100)).toBeUndefined();
  });

  it('returns undefined when rolloutPercent <= 0', () => {
    expect(resolveRolloutRuntime('lane-1', 0)).toBeUndefined();
    expect(resolveRolloutRuntime('lane-1', -5)).toBeUndefined();
  });

  it('always assigns docker-sandbox at rolloutPercent=100 for a fixed lane', () => {
    expect(resolveRolloutRuntime('lane-1', 100)).toBe('docker-sandbox');
  });

  it('assigns roughly rolloutPercent share of a large synthetic lane sample', () => {
    const total = 10_000;
    let assigned = 0;
    for (let i = 0; i < total; i++) {
      if (resolveRolloutRuntime(`lane-${i}`, 50) === 'docker-sandbox') assigned++;
    }
    const share = (assigned / total) * 100;
    expect(share).toBeGreaterThan(45);
    expect(share).toBeLessThan(55);
  });
});

describe('buildDarwinProfile', () => {
  const policy = {
    runtime: 'sandbox-exec' as const,
    worktree: '/tmp/worktree',
    writablePaths: ['/tmp/worktree', '/tmp/repo/.git'],
    writableFilePrefixes: [] as string[],
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

  it('renders an anchored regex rule per writableFilePrefixes entry', () => {
    const withPrefix = { ...policy, writableFilePrefixes: ['/home/factory/.claude.json'] };
    const profile = buildDarwinProfile(withPrefix);
    expect(profile).toContain('(allow file-write* (regex #"^/home/factory/\\\\.claude\\\\.json"))');
    expect(profile).toContain('(deny file-write*)');
    expect(profile).not.toContain('(subpath "/home/factory")');
  });

  it('escapes regex metacharacters and quotes in a writableFilePrefixes entry', () => {
    const withPrefix = { ...policy, writableFilePrefixes: ['/tmp/we"ird+path'] };
    const profile = buildDarwinProfile(withPrefix);
    expect(profile).toContain('(allow file-write* (regex #"^/tmp/we\\"ird\\\\+path"))');
  });

  it('emits no regex rule and stays a valid profile when writableFilePrefixes is empty', () => {
    const profile = buildDarwinProfile(policy);
    expect(profile).not.toContain('(regex ');
    expect(profile.startsWith('(version 1)')).toBe(true);
  });
});

describe('wrapCommandInSandbox', () => {
  const basePolicy = {
    worktree: '/tmp/worktree',
    writablePaths: ['/tmp/worktree'],
    writableFilePrefixes: [] as string[],
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

  it('passes writableFilePrefixes as --read-write flags too (firejail)', () => {
    const policy = {
      ...basePolicy,
      runtime: 'firejail' as const,
      writableFilePrefixes: ['/home/factory/.claude.json'],
    };
    const wrapped = wrapCommandInSandbox('echo hi', policy);
    expect(wrapped).toContain("--read-write='/home/factory/.claude.json'");
  });

  it('returns the command unchanged and never wraps for docker-sandbox', () => {
    const policy = { ...basePolicy, runtime: 'docker-sandbox' as const };
    const wrapped = wrapCommandInSandbox('echo hi', policy);
    expect(wrapped).toBe('echo hi');
    expect(wrapped).not.toContain('firejail');
    expect(wrapped).not.toContain('sandbox-exec');
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

  it('classifies a blocked ~/.ssh/id_rsa read under sandbox-exec as sandbox_violation', () => {
    const err = new HarnessError('boom', 'error', {
      stderr: 'sandbox-exec: deny(1) file-read-data /Users/x/.ssh/id_rsa',
    });
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

  it('classifies a HarnessError with reason local_auth as sandbox_auth_denied', () => {
    const err = new HarnessError('boom', 'local_auth', { stderr: '' });
    expect(sandboxEventFromError(err)).toMatchObject({ type: 'sandbox_auth_denied' });
  });

  it('classifies auth wording on stdout (not stderr) as sandbox_auth_denied', () => {
    const err = new HarnessError('boom', 'error', { stderr: '', stdout: 'Please run /login to continue' });
    expect(sandboxEventFromError(err)).toMatchObject({ type: 'sandbox_auth_denied' });
  });

  it('classifies SIGXCPU as resource_limit even when auth wording is also present', () => {
    const err = new HarnessError('boom', 'local_auth', { signal: 'SIGXCPU', stdout: 'Please run /login to continue' });
    expect(sandboxEventFromError(err)).toMatchObject({ type: 'resource_limit' });
  });
});
