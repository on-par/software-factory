import { join } from 'node:path';

import { getFactoryPaths, ProviderBreaker, readEvents } from '@on-par/factory-core';
import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { cmdBreakerReset, runBreakerReset, runBreakerResetCommand } from './breaker.js';
import { CliExitError, PROGRAM_HANDLERS } from './index.js';

const tmp = createTempDirs();
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await tmp.cleanup();
});

async function setup() {
  const dir = await tmp.make('cli-breaker-');
  const breaker = new ProviderBreaker(join(dir, 'breaker.json'), () => 1, { fingerprint: () => 'fp' });
  const logs: unknown[] = [];
  const out: string[] = [];
  return {
    breaker,
    logs,
    out,
    deps: { breaker, log: (...a: unknown[]) => logs.push(a), out: (l: string) => out.push(l) },
  };
}

describe('runBreakerReset', () => {
  it('removes an open entry and logs provider_breaker_close manual_reset', async () => {
    const { breaker, logs, out, deps } = await setup();
    await breaker.openUntilCredentialsChange('anthropic', 'local_auth');
    await runBreakerReset('anthropic', deps);
    expect(await breaker.status('anthropic')).toEqual({ open: false });
    expect(logs).toEqual([
      [
        'provider_breaker_close',
        expect.any(String),
        { providerBreakerClose: { provider: 'anthropic', cause: 'manual_reset' } },
      ],
    ]);
    expect(out).toEqual(['reset the anthropic breaker (local_auth)']);
  });

  it('exits 1 listing the open providers when the provider has no entry', async () => {
    const { breaker, deps } = await setup();
    await breaker.openUntilCredentialsChange('openai', 'local_auth');
    const err = await runBreakerReset('anthropic', deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliExitError);
    expect((err as CliExitError).message).toContain('open: openai');
    expect((err as CliExitError).code).toBe(1);
  });

  it('prints (none) when nothing is open', async () => {
    const { deps } = await setup();
    await expect(runBreakerReset('anthropic', deps)).rejects.toThrow('open: (none)');
  });
});

async function setupRepo() {
  vi.stubEnv('FACTORY_STATE_ROOT', '');
  const root = await tmp.make('cli-breaker-repo-');
  const paths = getFactoryPaths(root);
  const breaker = new ProviderBreaker(paths.breaker, () => 1, { fingerprint: () => 'fp' });
  await breaker.openUntilCredentialsChange('anthropic', 'local_auth');
  return { root, paths, breaker };
}

describe('runBreakerResetCommand', () => {
  it("resets the breaker in the repo's state and logs provider_breaker_close to its events file", async () => {
    const { root, paths, breaker } = await setupRepo();
    const out: string[] = [];
    await runBreakerResetCommand('anthropic', { getRepoRoot: async () => root, out: (l) => out.push(l) });
    expect(await breaker.status('anthropic')).toEqual({ open: false });
    expect(out).toEqual(['reset the anthropic breaker (local_auth)']);
    const closes = readEvents(paths.events).filter((e) => e.type === 'provider_breaker_close');
    expect(closes).toHaveLength(1);
    expect(closes[0]).toMatchObject({
      issue: '-',
      providerBreakerClose: { provider: 'anthropic', cause: 'manual_reset' },
    });
    const restored = readEvents(paths.events).filter((e) => e.type === 'provider_restored');
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({ providerRestored: { provider: 'anthropic', cause: 'manual_reset' } });
  });
});

describe('cmdBreakerReset', () => {
  it('resolves the repo root through PROGRAM_HANDLERS.getRepoRoot and prints to stdout', async () => {
    const { root, breaker } = await setupRepo();
    const getRepoRoot = vi.spyOn(PROGRAM_HANDLERS, 'getRepoRoot').mockResolvedValue(root);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await cmdBreakerReset('anthropic');
    expect(getRepoRoot).toHaveBeenCalledOnce();
    expect(await breaker.status('anthropic')).toEqual({ open: false });
    expect(log).toHaveBeenCalledWith('reset the anthropic breaker (local_auth)');
  });

  it('is the PROGRAM_HANDLERS entry program-advanced wires to `factory breaker reset`', () => {
    expect(PROGRAM_HANDLERS.cmdBreakerReset).toBe(cmdBreakerReset);
  });
});
