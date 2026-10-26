import { describe, expect, it, vi } from 'vitest';

import { leaseEnvironmentOrWarn, releaseEnvironmentOrWarn } from './environment-lease.js';
import type { Environment } from './ports.js';

function fakeEnv(port: number, release: () => Promise<void>): Environment {
  return { port, release, recordPgid: () => {}, env: () => ({}) };
}

describe('leaseEnvironmentOrWarn', () => {
  it('returns the leased environment', async () => {
    const env = fakeEnv(3100, async () => {});
    const log = vi.fn();
    expect(await leaseEnvironmentOrWarn(async () => env, log)).toBe(env);
    expect(log).not.toHaveBeenCalled();
  });

  it('logs and returns undefined when the lease fails', async () => {
    const log = vi.fn();
    const acquire = async (): Promise<Environment> => {
      throw new Error('no ports');
    };
    expect(await leaseEnvironmentOrWarn(acquire, log)).toBeUndefined();
    expect(log).toHaveBeenCalledWith('environment_lease_failed', expect.stringContaining('no ports'));
  });
});

describe('releaseEnvironmentOrWarn', () => {
  it('logs the released port', async () => {
    const log = vi.fn();
    await releaseEnvironmentOrWarn(
      fakeEnv(3100, async () => {}),
      '/wt',
      log,
    );
    expect(log).toHaveBeenCalledWith('environment_release', 'released port 3100 for worktree /wt');
  });

  it('logs a failed release instead of throwing', async () => {
    const log = vi.fn();
    const release = async (): Promise<void> => {
      throw new Error('boom');
    };
    await releaseEnvironmentOrWarn(fakeEnv(1, release), '/wt', log);
    expect(log).toHaveBeenCalledWith('environment_release_failed', 'port release failed: boom');
  });
});
