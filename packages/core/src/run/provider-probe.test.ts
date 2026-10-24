import { join } from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

import type { ProviderOrder } from '../config/provider-order.js';
import { createTempDirs } from '../harness/temp-dir.js';
import { ProviderBreaker } from '../router/breaker.js';
import { ModelRouterError } from '../router/executor-error.js';
import {
  PROBE_PROMPT,
  probeDueProviders,
  probeIfDue,
  probeModelFor,
  providerProbe,
  routerProviderProbe,
  type ProbeDeps,
} from './provider-probe.js';

const T_0705 = Date.parse('2026-10-20T12:05:00Z');
const CAPPED_UNTIL = '2026-10-20T12:00:00.000Z';
const DEFS: Record<string, { provider: string; harness: string; codex?: boolean }> = {
  'claude-w': { provider: 'anthropic', harness: 'claude-cli' },
  'claude-t': { provider: 'anthropic', harness: 'claude-cli' },
  'codex-w': { provider: 'openai', harness: 'codex-cli', codex: true },
};
const registry = { get: (id: string) => DEFS[id] } as never;
const ORDER: ProviderOrder = {
  boss: [],
  worker: ['claude-w', 'codex-w'],
  checker: [],
  triage: ['codex-w', 'claude-t'],
};

const tempDirs = createTempDirs();
const dir = tempDirs.makeSync('provider-probe-');
afterAll(() => tempDirs.cleanup());
let counter = 0;

async function setup(probe: (model: string) => Promise<void> = async () => {}, capped = ['anthropic']) {
  counter += 1;
  const breaker = new ProviderBreaker(join(dir, `b-${counter}.json`), () => T_0705);
  for (const p of capped) await breaker.open(p, 'usage_cap', 30 * 60_000, { cappedUntil: CAPPED_UNTIL });
  const logs: string[] = [];
  const spy = vi.fn(probe);
  const deps: ProbeDeps = { router: { registryRef: registry }, breaker, probe: spy, log: (_t, m) => logs.push(m) };
  return { deps, breaker, spy, logs };
}

describe('probe model and default probe', () => {
  it("probeModelFor picks the provider's triage entry, else the fallback", () => {
    expect(probeModelFor(ORDER, 'claude', registry, 'claude-w')).toBe('claude-t');
    expect(probeModelFor({ ...ORDER, triage: [] }, 'claude', registry, 'claude-w')).toBe('claude-w');
  });

  it('routerProviderProbe runs one 60s triage prompt pinned to the model', async () => {
    const run = vi.fn(async () => 'OK');
    await routerProviderProbe({ run } as never)('claude-t');
    expect(run).toHaveBeenCalledWith('triage', PROBE_PROMPT, {
      modelOverride: 'claude-t',
      modelFallbacks: [],
      timeoutSeconds: 60,
    });
  });

  it('providerProbe prefers the injected probe', () => {
    const injected = async () => {};
    expect(providerProbe({ router: {} as never, probeProvider: injected })).toBe(injected);
  });
});

describe('probeIfDue', () => {
  it('is not-due without a past-due cap', async () => {
    const { deps, spy } = await setup(undefined, []);
    expect(await probeIfDue(deps, ORDER, 'claude', 'anthropic', 'claude-w')).toBe('not-due');
    expect(spy).not.toHaveBeenCalled();
  });

  it('restores on a passing probe, on the triage model', async () => {
    const { deps, spy, breaker, logs } = await setup();
    expect(await probeIfDue(deps, ORDER, 'claude', 'anthropic', 'claude-w')).toBe('restored');
    expect(spy).toHaveBeenCalledWith('claude-t');
    expect((await breaker.status('anthropic')).open).toBe(false);
    expect(logs[0]).toContain('passed the restore probe');
  });

  it('reports taken, and logs it, when another lane holds the claim', async () => {
    const { deps, breaker, logs } = await setup();
    await breaker.claimProbe('anthropic');
    expect(await probeIfDue(deps, ORDER, 'claude', 'anthropic', 'claude-w')).toBe('taken');
    expect(logs[0]).toContain('already running in another lane');
  });

  it('re-caps from the reported reset on usage_cap', async () => {
    const detail = 'Resets in 2hr';
    const { deps, breaker, logs } = await setup(async () => {
      throw new ModelRouterError('cap', 'usage_cap', [{ model: 'm', reason: 'usage_cap', ok: false, detail }]);
    });
    expect(await probeIfDue(deps, ORDER, 'claude', 'anthropic', 'claude-w')).toBe('capped');
    expect(logs[0]).toContain('hit the usage cap again');
    expect((await breaker.status('anthropic')).open).toBe(true);
  });

  it('keeps the provider capped and never throws on any other failure', async () => {
    const timeout = await setup(async () => {
      throw new ModelRouterError('slow', 'timeout', [{ model: 'm', reason: 'timeout', ok: false }]);
    });
    expect(await probeIfDue(timeout.deps, ORDER, 'claude', 'anthropic', 'claude-w')).toBe('capped');
    expect(timeout.logs[0]).toContain('restore probe failed (timeout)');
    const plain = await setup(async () => {
      throw new Error('boom');
    });
    expect(await probeIfDue(plain.deps, ORDER, 'claude', 'anthropic', 'claude-w')).toBe('capped');
    expect(plain.logs[0]).toContain('restore probe failed (boom)');
    const bare = await setup(async () => {
      throw new Error('string failure');
    });
    expect(await probeIfDue({ ...bare.deps, log: undefined }, ORDER, 'claude', 'anthropic', 'claude-w')).toBe('capped');
  });
});

describe('probeDueProviders', () => {
  it('stops at the first usable provider and never probes a later one', async () => {
    const { deps, spy } = await setup(undefined, []);
    await deps.breaker.open('anthropic', 'rate_limit', 60_000);
    await probeDueProviders(deps, ORDER, 'build');
    expect(spy).not.toHaveBeenCalled();
  });

  it('probes a due provider and stops once it is restored', async () => {
    const { deps, spy } = await setup(undefined, ['anthropic', 'openai']);
    await probeDueProviders(deps, ORDER, 'build');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('continues past a still-capped provider to a due one, and skips unknown ids', async () => {
    const { deps, spy } = await setup(undefined, ['openai']);
    await deps.breaker.open('anthropic', 'usage_cap', 60 * 60_000, { cappedUntil: '2026-10-20T13:00:00.000Z' });
    await probeDueProviders(deps, { ...ORDER, worker: ['nope', 'claude-w', 'codex-w'] }, 'build');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('codex-w');
  });
});
