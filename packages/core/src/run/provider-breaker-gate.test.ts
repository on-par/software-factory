import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import type { EventKind } from '../events/kinds.js';
import { ProviderBreaker } from '../router/breaker.js';
import { ModelRouter } from '../router/index.js';
import { gateOpencodeBuildOnBreaker } from './provider-breaker-gate.js';

const ROUTES: RoutesConfig = {
  version: 1,
  routes: {
    build_claude: { tier: 'worker', description: 'stub', requires: 'claude' },
    build_codex: { tier: 'worker', description: 'stub', requires: 'codex' },
    build_opencode: { tier: 'worker', description: 'stub', requires: 'opencode' },
  },
};

type ModelDef = { provider: string; codex?: boolean; harness?: string };

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
