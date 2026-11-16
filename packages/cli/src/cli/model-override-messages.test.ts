import { describe, expect, it } from 'vitest';

import { ModelRouter, type ModelsConfig, type RoutesConfig } from '@on-par/factory-core';

import { applyMeteredGuard } from './model-override-messages.js';

const models: ModelsConfig = {
  version: 1,
  models: {
    'local-m': {
      provider: 'custom',
      tier: 'boss',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
      harness: 'pi',
    },
  },
  tiers: { boss: ['local-m'] },
  failover: { triggers: ['rate_limit'], maxRetries: 1, cooldownMs: 0 },
  routingRules: {},
};
const routes: RoutesConfig = { version: 1, routes: { plan: { tier: 'boss', description: 'stub' } } };

describe('applyMeteredGuard', () => {
  it('turns the guard on once and warns once for a metered pinned route', () => {
    const real = new ModelRouter(models, routes);
    const planDeps: unknown[] = [];
    const router = { registryRef: real.registryRef, setProviderPlanDeps: (d: unknown) => planDeps.push(d) } as never;
    const logs: [string, string][] = [];
    applyMeteredGuard(router, { plan: 'local-m', sources: {} }, (t, m) => logs.push([t, m]));
    expect(planDeps).toEqual([{}]);
    expect(logs).toHaveLength(1);
    expect(logs[0][0]).toBe('warn');
    expect(logs[0][1]).toMatch(/^metered_primary_route: plan is pinned to local-m/);
  });

  it('logs nothing when no route is pinned', () => {
    const logs: [string, string][] = [];
    applyMeteredGuard(new ModelRouter(models, routes), { sources: {} }, (t, m) => logs.push([t, m]));
    expect(logs).toEqual([]);
  });
});
