import { describe, expect, it } from 'vitest';
import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { ModelRouter } from './index.js';
import { StubModelExecutor } from './stub.js';

const models: ModelsConfig = {
  version: 1,
  models: {
    'stub-model': {
      provider: 'custom',
      tier: 'boss',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
    },
  },
  tiers: { boss: ['stub-model'] },
  failover: {
    triggers: ['rate_limit', 'usage_cap', 'timeout', 'error', 'empty_response'],
    maxRetries: 2,
    cooldownMs: 0,
    escalateAfterTierExhausted: true,
  },
  routingRules: {},
};

const routes: RoutesConfig = {
  version: 1,
  routes: {
    plan: { tier: 'boss', description: 'stub' },
  },
};

describe('ModelRouter with StubModelExecutor', () => {
  it('returns canned responses without invoking a CLI', async () => {
    const stub = new StubModelExecutor({ scripts: { plan: [{ output: 'SCRIPTED PLAN' }] } });
    const router = new ModelRouter(models, routes, false, stub);

    const result = await router.run('plan', 'do it');

    expect(result.output).toBe('SCRIPTED PLAN');
    expect(result.model).toBe('stub-model');
    expect(result.attempts).toEqual([{ model: 'stub-model', reason: null, ok: true }]);
    expect(stub.calls).toHaveLength(1);
  });

  it('retries a simulated rate limit and then succeeds', async () => {
    const stub = new StubModelExecutor({
      scripts: { plan: [{ fail: 'rate_limit' }, { output: 'RECOVERED' }] },
    });
    const router = new ModelRouter(models, routes, false, stub);

    const result = await router.run('plan', 'do it');

    expect(result.output).toBe('RECOVERED');
    expect(result.attempts).toEqual([
      { model: 'stub-model', reason: 'rate_limit', ok: false },
      { model: 'stub-model', reason: null, ok: true },
    ]);
    expect(stub.calls).toHaveLength(2);
  });

  it('throws when scripted failures exhaust retries', async () => {
    const stub = new StubModelExecutor({
      scripts: { plan: [{ fail: 'error' }, { fail: 'error' }] },
    });
    const router = new ModelRouter(models, routes, false, stub);

    await expect(router.run('plan', 'do it')).rejects.toThrow(
      "All models failed for task 'plan': stub-model(error), stub-model(error)",
    );
    expect(stub.calls).toHaveLength(2);
  });
});
