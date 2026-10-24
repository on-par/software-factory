import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import type { EventKind } from '../events/kinds.js';
import { ProviderBreaker } from '../router/breaker.js';
import { ModelRouter } from '../router/index.js';
import type { ProviderOrder } from '../config/provider-order.js';
import { ModelRouterError } from '../router/executor-error.js';
import {
  gateOpencodeBuildOnBreaker,
  pickOrderedProvider,
  runWithProviderFailover,
  type ProviderPick,
} from './provider-breaker-gate.js';

const ROUTES: RoutesConfig = {
  version: 1,
  routes: {
    build_claude: { tier: 'worker', description: 'stub', requires: 'claude' },
    build_codex: { tier: 'worker', description: 'stub', requires: 'codex' },
    build_opencode: { tier: 'worker', description: 'stub', requires: 'opencode' },
  },
};

type ModelDef = { provider: string; codex?: boolean; harness?: string; providerModel?: string };

function routerWith(defs: Record<string, ModelDef>): ModelRouter {
  const models: ModelsConfig = {
    version: 1,
    models: Object.fromEntries(
      Object.entries(defs).map(([id, def]) => [
        id,
        {
          provider: def.provider as ModelsConfig['models'][string]['provider'],
          tier: 'worker',
          costPerMtokInput: 0,
          costPerMtokOutput: 0,
          contextWindow: 1000,
          capabilities: [],
          envKey: null,
          ...(def.codex ? { codex: true } : {}),
          ...(def.harness ? { harness: def.harness } : {}),
          ...(def.providerModel ? { providerModel: def.providerModel } : {}),
        },
      ]),
    ),
    tiers: { worker: Object.keys(defs) },
    failover: { triggers: [], maxRetries: 0, cooldownMs: 0 },
    routingRules: {},
  };
  return new ModelRouter(models, ROUTES);
}

const dir = mkdtempSync(join(tmpdir(), 'provider-breaker-gate-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let counter = 0;
const NOW = Date.parse('2026-01-01T00:00:00.000Z');

const CLAUDE_MODELS = {
  'oc-build': { provider: 'opencode-go', harness: 'opencode' },
  'claude-build': { provider: 'anthropic' },
};
const CODEX_ONLY = {
  'oc-build': { provider: 'opencode-go', harness: 'opencode' },
  'gpt-build': { provider: 'openai', codex: true },
};

async function setup(open: boolean, models: Record<string, ModelDef> = CLAUDE_MODELS) {
  counter += 1;
  const breaker = new ProviderBreaker(join(dir, `b-${counter}.json`), () => NOW);
  if (open) await breaker.open('opencode-go', 'usage_cap', 30 * 60_000);
  const events: Array<[EventKind, string]> = [];
  const deps = { router: routerWith(models), breaker, log: (t: EventKind, m: string) => events.push([t, m]) };
  return { deps, events };
}

const base = { opencodeModel: 'oc-build', routePinned: false, codexDisabled: false, now: NOW };

describe('gateOpencodeBuildOnBreaker', () => {
  it('swaps an unpinned open route to claude with the breaker reason and logs provider_breaker_skip', async () => {
    const { deps, events } = await setup(true);
    const gate = await gateOpencodeBuildOnBreaker(deps, base);
    expect(gate).toMatchObject({
      kind: 'swap',
      route: 'claude',
      task: 'build_claude',
      model: 'claude-build',
      reason: 'usage_cap',
    });
    expect(events.some(([t]) => t === 'provider_breaker_skip')).toBe(true);
  });

  it('returns undefined when only codex exists and codex is disabled', async () => {
    const { deps } = await setup(true, CODEX_ONLY);
    expect(await gateOpencodeBuildOnBreaker(deps, { ...base, codexDisabled: true })).toBeUndefined();
  });

  it('returns undefined for an unpinned closed breaker', async () => {
    const { deps } = await setup(false);
    expect(await gateOpencodeBuildOnBreaker(deps, base)).toBeUndefined();
  });

  it('blocks a pinned open route with the reason and reset time', async () => {
    const { deps, events } = await setup(true);
    const gate = await gateOpencodeBuildOnBreaker(deps, { ...base, routePinned: true });
    expect(gate?.kind).toBe('blocked');
    if (gate?.kind !== 'blocked') return;
    expect(gate.reason).toBe('usage_cap');
    expect(gate.resetAt).toBe(new Date(NOW + 30 * 60_000).toISOString());
    expect(gate.message).toContain('usage_cap');
    expect(gate.message).toContain('ADR-0092');
    expect(gate.message).toContain(`resets at ${gate.resetAt}`);
    expect(events.some(([t]) => t === 'provider_breaker_pinned')).toBe(true);
  });

  it('returns undefined for a pinned closed breaker', async () => {
    const { deps } = await setup(false);
    expect(await gateOpencodeBuildOnBreaker(deps, { ...base, routePinned: true })).toBeUndefined();
  });

  it('returns undefined when there is no opencode model', async () => {
    const { deps } = await setup(true);
    expect(await gateOpencodeBuildOnBreaker(deps, { ...base, opencodeModel: undefined })).toBeUndefined();
  });
});

const ORDERED_MODELS = {
  'claude-w': { provider: 'anthropic', harness: 'claude-cli' },
  'codex-w': { provider: 'openai', harness: 'codex-cli', codex: true },
  'og-w': { provider: 'custom', harness: 'opencode', providerModel: 'opencode-go/deepseek-v4-flash' },
};
const order = (worker: string[]): ProviderOrder => ({ boss: [], worker, checker: [], triage: [] });
const ALL = order(['claude-w', 'codex-w', 'og-w']);
const capErr = () => new ModelRouterError('cap', 'usage_cap', [{ model: 'claude-w', reason: 'usage_cap', ok: false }]);

async function orderedDeps() {
  counter += 1;
  const breaker = new ProviderBreaker(join(dir, `ordered-${counter}.json`));
  return { router: routerWith(ORDERED_MODELS), breaker };
}

describe('pickOrderedProvider', () => {
  it('returns the first entry when every breaker is closed', async () => {
    const pick = await pickOrderedProvider(await orderedDeps(), ALL, 'build', new Set());
    expect(pick).toEqual({ provider: 'claude', model: 'claude-w', skipped: new Set() });
  });

  it('skips a breaker-open provider and records its key', async () => {
    const deps = await orderedDeps();
    await deps.breaker.open('anthropic', 'usage_cap', 60_000);
    const pick = await pickOrderedProvider(deps, ALL, 'build', new Set());
    expect(pick).toMatchObject({ provider: 'codex', model: 'codex-w' });
    expect([...(pick?.skipped ?? [])]).toEqual(['anthropic']);
  });

  it('honors exclude', async () => {
    const pick = await pickOrderedProvider(await orderedDeps(), ALL, 'build', new Set(['claude', 'codex'] as const));
    expect(pick).toMatchObject({ provider: 'opencode-go', model: 'og-w' });
    expect([...(pick?.skipped ?? [])]).toEqual(['anthropic', 'openai']);
  });

  it('returns undefined when every provider is capped or excluded', async () => {
    const deps = await orderedDeps();
    await deps.breaker.open('openai', 'usage_cap', 60_000);
    expect(await pickOrderedProvider(deps, order(['codex-w', 'claude-w']), 'build', new Set(['claude'] as const))).toBe(
      undefined,
    );
  });

  it('returns undefined for an empty role list', async () => {
    expect(await pickOrderedProvider(await orderedDeps(), ALL, 'plan', new Set())).toBeUndefined();
  });

  it('ignores unknown and non-subscription ids', async () => {
    const deps = await orderedDeps();
    const pick = await pickOrderedProvider(deps, order(['nope', 'zen/x', 'codex-w']), 'build', new Set());
    expect(pick).toMatchObject({ provider: 'codex' });
  });
});

describe('pickOrderedProvider restore probe (#3339)', () => {
  async function dueDeps(probe: () => Promise<void>) {
    counter += 1;
    let t = 0;
    const breaker = new ProviderBreaker(join(dir, `probe-${counter}.json`), () => t);
    await breaker.open('anthropic', 'usage_cap', 60_000, { cappedUntil: new Date(60_000).toISOString() });
    t = 120_000;
    return { router: routerWith(ORDERED_MODELS), breaker, probe: vi.fn(probe) };
  }

  it('returns the restored earlier provider when the probe succeeds', async () => {
    const deps = await dueDeps(async () => {});
    const pick = await pickOrderedProvider(deps, ALL, 'build', new Set());
    expect(pick).toEqual({ provider: 'claude', model: 'claude-w', skipped: new Set() });
    expect(deps.probe).toHaveBeenCalledTimes(1);
  });

  it('skips the provider when the probe fails', async () => {
    const deps = await dueDeps(async () => {
      throw capErr();
    });
    const pick = await pickOrderedProvider(deps, ALL, 'build', new Set());
    expect(pick).toMatchObject({ provider: 'codex', model: 'codex-w' });
    expect([...(pick?.skipped ?? [])]).toEqual(['anthropic']);
  });
});

describe('runWithProviderFailover', () => {
  async function setup(worker = ALL) {
    const log = vi.fn();
    return { deps: { ...(await orderedDeps()), log, issue: 7, order: worker }, log };
  }

  it('reruns once on the next provider after a usage cap and logs one provider_failover', async () => {
    const { deps, log } = await setup();
    const seen: Array<ProviderPick | undefined> = [];
    const beforeRerun = vi.fn(async () => true);
    const result = await runWithProviderFailover(
      deps,
      'build',
      async (pick) => {
        seen.push(pick);
        if (seen.length === 1) throw capErr();
        return 'done';
      },
      { beforeRerun },
    );
    expect(result).toBe('done');
    expect(seen.map((p) => p?.provider)).toEqual(['claude', 'codex']);
    expect(beforeRerun).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toBe('provider_failover');
    expect(log.mock.calls[0]?.[2]).toEqual({
      providerFailover: { stage: 'build', from: 'claude', to: 'codex', issue: 7 },
    });
  });

  it('rethrows a non-cap error without a rerun', async () => {
    const { deps, log } = await setup();
    const attempt = vi.fn(async () => {
      throw new ModelRouterError('x', 'error', []);
    });
    await expect(runWithProviderFailover(deps, 'build', attempt)).rejects.toThrow('x');
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalled();
  });

  it('rethrows the original cap error when the last provider is capped', async () => {
    const { deps, log } = await setup(order(['claude-w']));
    const err = capErr();
    const attempt = vi.fn(async () => {
      throw err;
    });
    await expect(runWithProviderFailover(deps, 'build', attempt)).rejects.toBe(err);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalled();
  });

  it('rethrows the cap when beforeRerun refuses, and propagates when it throws', async () => {
    const { deps } = await setup();
    const err = capErr();
    const attempt = vi.fn(async () => {
      throw err;
    });
    await expect(runWithProviderFailover(deps, 'build', attempt, { beforeRerun: async () => false })).rejects.toBe(err);
    await expect(
      runWithProviderFailover(deps, 'build', attempt, {
        beforeRerun: async () => {
          throw new Error('reset failed');
        },
      }),
    ).rejects.toThrow('reset failed');
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('calls the attempt once with undefined when nothing can be picked', async () => {
    const { deps } = await setup(order([]));
    const attempt = vi.fn(async (_pick: ProviderPick | undefined) => 'ok');
    expect(await runWithProviderFailover(deps, 'build', attempt)).toBe('ok');
    expect(attempt).toHaveBeenCalledExactlyOnceWith(undefined);
  });
});
