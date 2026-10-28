import { describe, expect, it } from 'vitest';

import { buildDarwinProfile, wrapCommandInSandbox } from './index.js';

describe('evidence loopback allowance (#3748)', () => {
  const policy = {
    runtime: 'sandbox-exec' as const,
    worktree: '/tmp/worktree',
    writablePaths: ['/tmp/worktree', '/tmp/repo/.git'],
    writableFilePrefixes: [] as string[],
    allowHosts: [] as string[],
    cpuMs: 300_000,
    memMb: 4096,
  };

  it('allowLoopback with an empty allowlist keeps the outbound deny and allows only localhost (#3748)', () => {
    const profile = buildDarwinProfile({ ...policy, allowLoopback: true });
    const allow = '(allow network-outbound (remote ip "localhost:*"))';
    expect(profile).toContain('(deny network-outbound)');
    expect(profile).toContain(allow);
    expect(profile.indexOf(allow)).toBeGreaterThan(profile.indexOf('(deny network-outbound)'));
    expect(profile.split('(allow network-outbound').length - 1).toBe(1);
    expect(profile).not.toContain('mDNSResponder');
  });

  it('without allowLoopback the empty-allowlist profile is unchanged', () => {
    expect(buildDarwinProfile({ ...policy, allowLoopback: false })).toBe(buildDarwinProfile(policy));
    expect(buildDarwinProfile(policy)).toMatch(/\(deny network-outbound\)$/);
  });

  it('firejail evidence policy keeps --net=none, which leaves loopback up (#3748)', () => {
    const firejailPolicy = { ...policy, runtime: 'firejail' as const };
    const wrapped = wrapCommandInSandbox('echo hi', { ...firejailPolicy, allowLoopback: true });
    expect(wrapped).toContain('--net=none');
    expect(wrapped).toBe(wrapCommandInSandbox('echo hi', firejailPolicy));
  });
});
