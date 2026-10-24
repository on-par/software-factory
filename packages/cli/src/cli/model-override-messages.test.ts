import { describe, expect, it, vi } from 'vitest';

import { ModelRouter, type EffectiveModelPins, type ModelsConfig, type RoutesConfig } from '@on-par/factory-core';

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
    const router = new ModelRouter(models, routes);
    const setProviderPlanDeps = vi.spyOn(router, 'setProviderPlanDeps');
    const pins: EffectiveModelPins = { plan: 'local-m', sources: {} };
    const log = vi.fn();

    applyMeteredGuard(router, pins, log);

    expect(setProviderPlanDeps).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      'warn',
      expect.stringMatching(/^metered_primary_route: plan is pinned to local-m/),
    );
  });

  it('logs nothing when no route is pinned', () => {
    const log = vi.fn();
    applyMeteredGuard(new ModelRouter(models, routes), { sources: {} }, log);
    expect(log).not.toHaveBeenCalled();
  });
});
