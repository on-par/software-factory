import { describe, expect, it, vi } from 'vitest';

import type { ModelsConfig } from '../config/index.js';
import { diagnoseModels, ModelRegistry } from './index.js';
import { type PiAuthStatus, type PiSpawn, runPiAuthCheck } from './pi-auth.js';

const config: ModelsConfig = {
  version: 1,
  models: {},
  tiers: { boss: [] },
  failover: {
    triggers: ['rate_limit', 'usage_cap', 'timeout', 'error', 'empty_response'],
    maxRetries: 2,
    cooldownMs: 0,
    escalateAfterTierExhausted: true,
  },
  routingRules: {},
};

describe('diagnoseModels pi auth check (#2903)', () => {
  const piModel = (providerModel?: string): ModelsConfig['models'][string] => ({
    provider: 'custom',
    tier: 'boss',
    costPerMtokInput: 0,
    costPerMtokOutput: 0,
    contextWindow: 1000,
    capabilities: [],
    envKey: null,
    harness: 'pi',
    ...(providerModel ? { providerModel } : {}),
  });
  const piConfig = (models: Record<string, ModelsConfig['models'][string]>): ModelsConfig => ({
    ...config,
    models,
    tiers: { boss: Object.keys(models) },
  });
  const diagnose = (cfg: ModelsConfig, piAuthCheck: (m: string) => PiAuthStatus, pi = true) =>
    diagnoseModels(
      new ModelRegistry(cfg),
      { commandAvailable: (c) => pi && c === 'pi', envPresent: () => false, piAuthCheck },
      true,
    );
  const single = piConfig({ 'pi-a': piModel('openrouter/x/y') });

  it('ready is reachable with ok (pi CLI)', () => {
    const [d] = diagnose(single, () => 'ready');
    expect(d).toMatchObject({ reachable: true, unverified: false, reason: 'ok (pi CLI)' });
  });

  it('not_ready is unverified with the /login hint', () => {
    const [d] = diagnose(single, () => 'not_ready');
    expect(d.reachable).toBe(false);
    expect(d.unverified).toBe(true);
    expect(d.reason).toContain('not_ready');
    expect(d.reason).toContain('openrouter/x/y');
    expect(d.reason).toContain('/login');
  });

  it('invalid is unreachable with invalid credentials', () => {
    const [d] = diagnose(single, () => 'invalid');
    expect(d.reachable).toBe(false);
    expect(d.unverified).toBe(false);
    expect(d.reason).toContain('invalid credentials');
  });

  it('unknown and a throwing probe are unverified', () => {
    const [u] = diagnose(single, () => 'unknown');
    expect(u).toMatchObject({ reachable: false, unverified: true });
    expect(u.reason).toContain('could not run `pi auth check`');
    const [t] = diagnose(single, () => {
      throw new Error('boom');
    });
    expect(t).toMatchObject({ reachable: false, unverified: true });
  });

  it('does not run the probe when pi is not on PATH', () => {
    const probe = vi.fn<(m: string) => PiAuthStatus>(() => 'ready');
    const [d] = diagnose(single, probe, false);
    expect(d.reason).toBe('pi CLI not found on PATH');
    expect(probe).not.toHaveBeenCalled();
  });

  it('runs the check once per distinct provider model', () => {
    const probe = vi.fn<(m: string) => PiAuthStatus>(() => 'ready');
    const rows = diagnose(piConfig({ 'pi-a': piModel('openrouter/x/y'), 'pi-b': piModel('openrouter/x/y') }), probe);
    expect(rows.every((r) => r.reachable)).toBe(true);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledWith('openrouter/x/y');
  });

  it('falls back to the model id when there is no providerModel', () => {
    const probe = vi.fn<(m: string) => PiAuthStatus>(() => 'ready');
    diagnose(piConfig({ 'pi-c': piModel() }), probe);
    expect(probe).toHaveBeenCalledWith('pi-c');
  });
});

describe('runPiAuthCheck (#2903)', () => {
  const fake = (res: Partial<ReturnType<PiSpawn>> | Error) => {
    const spawn = vi.fn<PiSpawn>(() => {
      if (res instanceof Error) throw res;
      return { status: null, signal: null, stdout: '', ...res };
    });
    return { spawn, asSpawn: spawn };
  };

  it('passes an argv array and clears DEEPSEEK_API_KEY', () => {
    const { spawn, asSpawn } = fake({ status: 0, stdout: 'ready\n', signal: null });
    runPiAuthCheck('openrouter/x/y', asSpawn);
    const [cmd, args, opts] = spawn.mock.calls[0]!;
    expect(cmd).toBe('pi');
    expect(args).toEqual(['auth', 'check', '--model', 'openrouter/x/y', '--no-refresh']);
    expect(opts?.env?.DEEPSEEK_API_KEY).toBeUndefined();
  });

  it.each([
    [0, 'ready', 'ready'],
    [1, 'not_ready', 'not_ready'],
    [2, 'invalid', 'invalid'],
    [0, '\n  READY  \nextra', 'ready'],
  ])('exit %i with stdout %j is %s', (status, stdout, expected) => {
    expect(runPiAuthCheck('m', fake({ status, stdout, signal: null }).asSpawn)).toBe(expected);
  });

  it.each([
    ['usage error', { status: 1, stdout: 'error: unknown command auth', signal: null }],
    ['mismatched token', { status: 0, stdout: 'nope', signal: null }],
    ['unexpected exit code', { status: 3, stdout: 'ready', signal: null }],
    ['spawn error', { status: null, stdout: '', signal: null, error: new Error('ENOENT') }],
    ['signal', { status: null, stdout: '', signal: 'SIGTERM' as const }],
    ['null status', { status: null, stdout: '', signal: null }],
    ['no stdout', { status: 0, signal: null }],
    ['spawn throws', new Error('boom')],
  ])('%s is unknown', (_name, res) => {
    expect(runPiAuthCheck('m', fake(res).asSpawn)).toBe('unknown');
  });
});
