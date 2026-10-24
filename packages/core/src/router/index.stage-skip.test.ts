import { describe, expect, it } from 'vitest';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { ModelRouter } from './index.js';
import { StubModelExecutor } from './stub.js';

const routes: RoutesConfig = { version: 1, routes: { plan: { tier: 'planners', description: 'stub' } } };

const base = {
  tier: 'planners',
  costPerMtokInput: 0,
  costPerMtokOutput: 0,
  contextWindow: 1000,
  capabilities: [],
  envKey: null,
};

const models: ModelsConfig = {
  version: 1,
  models: {
    'anth-a': { ...base, provider: 'anthropic' },
    'oai-x': { ...base, provider: 'openai' },
    'cust-y': { ...base, provider: 'custom' },
  },
  tiers: { planners: ['anth-a', 'oai-x', 'cust-y'] },
  failover: { triggers: [], maxRetries: 0, cooldownMs: 0 },
  routingRules: {},
};

function setup() {
  const stub = new StubModelExecutor({ defaultOutput: 'ok' });
  return { stub, router: new ModelRouter(models, routes, false, stub) };
}

const modelsCalled = (stub: StubModelExecutor) => stub.calls.map((c) => c.model);

describe('ModelRouter.setStageSkipProviders (#3338)', () => {
  it('skips that provider’s models in run()', async () => {
    const { router, stub } = setup();
    router.setStageSkipProviders(new Set(['anthropic']));
    const result = await router.run('plan', 'p');
    expect(result.model).toBe('oai-x');
    expect(modelsCalled(stub)).not.toContain('anth-a');
  });

  it('merges with the per-call skipProviders', async () => {
    const { router, stub } = setup();
    router.setStageSkipProviders(new Set(['anthropic']));
    const result = await router.run('plan', 'p', { skipProviders: new Set(['openai']) });
    expect(result.model).toBe('cust-y');
    expect(modelsCalled(stub)).toEqual(['cust-y']);
  });

  it('undefined (or an empty set) clears it', async () => {
    const { router } = setup();
    router.setStageSkipProviders(new Set(['anthropic']));
    router.setStageSkipProviders(undefined);
    expect((await router.run('plan', 'p')).model).toBe('anth-a');
    router.setStageSkipProviders(new Set(['anthropic']));
    router.setStageSkipProviders(new Set());
    expect((await router.run('plan', 'p')).model).toBe('anth-a');
  });
});
