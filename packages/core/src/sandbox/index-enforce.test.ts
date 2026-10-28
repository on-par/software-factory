import { spawnSync } from 'node:child_process';
import net from 'node:net';

import { afterAll, describe, expect, it } from 'vitest';

import type { FactoryConfig } from '../config/index.js';

import { buildDarwinProfile, isEgressEnforced, resolveSandboxNetworkMode, resolveSandboxPolicy } from './index.js';

const defaultSandboxCfg: FactoryConfig['sandbox'] = {
  enabled: true,
  runtime: 'auto',
  network: { allow: ['api.anthropic.com', 'github.com'] },
  resources: { cpuMs: 300_000, memMb: 4096 },
  docker: { rolloutPercent: 0 },
};

describe('resolveSandboxNetworkMode (#2215)', () => {
  it('defaults to report', () => {
    expect(resolveSandboxNetworkMode(undefined, {})).toBe('report');
  });
  it('uses the configured mode', () => {
    expect(resolveSandboxNetworkMode('enforce', {})).toBe('enforce');
  });
  it('lets FACTORY_SANDBOX_NETWORK beat config in both directions', () => {
    expect(resolveSandboxNetworkMode('report', { FACTORY_SANDBOX_NETWORK: 'enforce' })).toBe('enforce');
    expect(resolveSandboxNetworkMode('enforce', { FACTORY_SANDBOX_NETWORK: 'report' })).toBe('report');
  });
  it.each(['ENFORCE', 'block', ''])('ignores env value %j', (value) => {
    expect(resolveSandboxNetworkMode('enforce', { FACTORY_SANDBOX_NETWORK: value })).toBe('enforce');
    expect(resolveSandboxNetworkMode(undefined, { FACTORY_SANDBOX_NETWORK: value })).toBe('report');
  });

  it('resolveSandboxPolicy returns networkMode from config and env', () => {
    const opts = {
      worktree: '/tmp/w',
      repoRoot: '/tmp/nonexistent-repo-2215',
      platform: 'linux' as NodeJS.Platform,
      isAvailable: () => false,
      homedir: '/home/factory',
      tmpdir: '/tmp',
    };
    expect(resolveSandboxPolicy(defaultSandboxCfg, { ...opts, env: {} })?.networkMode).toBe('report');
    const enforce = { ...defaultSandboxCfg, network: { ...defaultSandboxCfg.network, mode: 'enforce' as const } };
    expect(resolveSandboxPolicy(enforce, { ...opts, env: {} })?.networkMode).toBe('enforce');
    expect(
      resolveSandboxPolicy(defaultSandboxCfg, { ...opts, env: { FACTORY_SANDBOX_NETWORK: 'enforce' } })?.networkMode,
    ).toBe('enforce');
  });
});

describe('buildDarwinProfile enforce mode (#2215)', () => {
  const base = {
    runtime: 'sandbox-exec' as const,
    worktree: '/tmp/worktree',
    writablePaths: ['/tmp/worktree'],
    writableFilePrefixes: [] as string[],
    allowHosts: ['api.anthropic.com'],
    cpuMs: 300_000,
    memMb: 4096,
  };

  it('denies network-outbound except loopback and mDNSResponder in enforce mode', () => {
    const profile = buildDarwinProfile({ ...base, networkMode: 'enforce' });
    expect(profile).toContain('(deny network-outbound)');
    expect(profile).toContain('(allow network-outbound (remote ip "localhost:*"))');
    expect(profile).toContain(
      '(allow network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))',
    );
  });

  it('report mode is byte-identical to a policy without networkMode', () => {
    expect(buildDarwinProfile({ ...base, networkMode: 'report' })).toBe(buildDarwinProfile(base));
    expect(buildDarwinProfile(base)).not.toContain('network-outbound');
  });

  it('enforce with a non-empty allowlist ignores allowLoopback (#3748)', () => {
    const enforce = { ...base, networkMode: 'enforce' as const };
    expect(buildDarwinProfile({ ...enforce, allowLoopback: true })).toBe(buildDarwinProfile(enforce));
  });

  it('enforce with an empty allowlist equals the deny-all profile', () => {
    const empty = { ...base, allowHosts: [] as string[] };
    expect(buildDarwinProfile({ ...empty, networkMode: 'enforce' })).toBe(buildDarwinProfile(empty));
    expect(buildDarwinProfile(empty)).toMatch(/\(deny network-outbound\)$/);
  });
});

describe('isEgressEnforced (#2215)', () => {
  const base = {
    worktree: '/w',
    writablePaths: [] as string[],
    writableFilePrefixes: [] as string[],
    allowHosts: ['api.anthropic.com'],
    cpuMs: 1000,
    memMb: 1,
  };
  it('is true only for sandbox-exec, enforce, and a non-empty allowlist', () => {
    expect(isEgressEnforced(undefined)).toBe(false);
    expect(isEgressEnforced({ ...base, runtime: 'sandbox-exec', networkMode: 'enforce' })).toBe(true);
    expect(isEgressEnforced({ ...base, runtime: 'sandbox-exec', networkMode: 'report' })).toBe(false);
    expect(isEgressEnforced({ ...base, runtime: 'sandbox-exec' })).toBe(false);
    expect(isEgressEnforced({ ...base, runtime: 'firejail', networkMode: 'enforce' })).toBe(false);
    expect(isEgressEnforced({ ...base, runtime: 'sandbox-exec', networkMode: 'enforce', allowHosts: [] })).toBe(false);
  });
});

const SANDBOX_BIN = ['sandbox', 'exec'].join('-');
const canApplySandbox =
  process.platform === 'darwin' &&
  spawnSync(SANDBOX_BIN, ['-p', '(version 1)(allow default)', '/usr/bin/true']).status === 0;

describe.runIf(canApplySandbox)('sandbox-exec enforce profile (#2215)', () => {
  const policy = {
    runtime: 'sandbox-exec' as const,
    worktree: '/tmp/worktree',
    writablePaths: ['/tmp/worktree'],
    writableFilePrefixes: [] as string[],
    allowHosts: ['api.anthropic.com'],
    networkMode: 'enforce' as const,
    cpuMs: 300_000,
    memMb: 4096,
  };
  const connectScript = (host: string, port: number): string =>
    `const s = require('net').connect(${port}, '${host}'); s.on('connect', () => { console.log('connected'); s.destroy(); }); s.on('error', (e) => console.log(e.code)); setTimeout(() => process.exit(0), 3000).unref();`;
  const run = (host: string, port: number): string =>
    spawnSync(SANDBOX_BIN, ['-p', buildDarwinProfile(policy), process.execPath, '-e', connectScript(host, port)], {
      encoding: 'utf8',
    }).stdout.trim();

  const server = net.createServer((s) => s.destroy());
  const listening = new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('a direct connect to 1.1.1.1:443 fails with EPERM', () => {
    expect(run('1.1.1.1', 443)).toBe('EPERM');
  });

  it('a connect to a loopback server succeeds', async () => {
    await listening;
    expect(run('127.0.0.1', (server.address() as net.AddressInfo).port)).toBe('connected');
  });
});
