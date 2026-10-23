import { describe, expect, it } from 'vitest';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { ModelRouter } from './index.js';
import { StubModelExecutor } from './stub.js';

const routes: RoutesConfig = { version: 1, routes: { plan: { tier: 'boss', description: 'stub' } } };
type CostRowInput = Parameters<Parameters<ModelRouter['setCostSink']>[0]>[0];

const baseModels: ModelsConfig = {
  version: 1,
  models: {
    'stub-model': {
      provider: 'custom',
      tier: 'boss',
      costPerMtokInput: 3,
      costPerMtokOutput: 15,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
    },
  },
  tiers: { boss: ['stub-model'] },
  failover: {
    triggers: ['rate_limit', 'unavailable', 'auth'],
    maxRetries: 2,
    cooldownMs: 0,
  },
  routingRules: {},
};

describe('ModelRouter cost sink cache-read pricing', () => {
  const cachedModels = (cached?: number): ModelsConfig => ({
    ...baseModels,
    models: {
      'stub-model': {
        ...baseModels.models['stub-model'],
        costPerMtokInput: 1.25,
        costPerMtokOutput: 10,
        ...(cached === undefined ? {} : { costPerMtokCachedInput: cached }),
      },
    },
  });
  const build3264 = { inputTokens: 25_102_465, cacheReadTokens: 24_881_152, outputTokens: 58_935 };
  const runWithUsage = async (models: ModelsConfig, usage: Record<string, number>) => {
    const stub = new StubModelExecutor({
      scripts: { plan: [{ output: 'X', effect: (ctx) => ctx.onUsage?.(usage as never) }] },
    });
    const router = new ModelRouter(models, routes, false, stub);
    const rows: CostRowInput[] = [];
    router.setCostSink((entry) => rows.push(entry));
    await router.run('plan', 'do it');
    return rows[0];
  };

  it('flags cachedRateMissing when cache reads are priced at the full input rate (#3284)', async () => {
    const row = await runWithUsage(cachedModels(), build3264);
    expect(row.cost).toBeCloseTo(31.9674, 4);
    expect(row.cachedRateMissing).toBe(true);
  });

  it('prices cache reads at the cached rate and sets no cachedRateMissing key (#3284)', async () => {
    const row = await runWithUsage(cachedModels(0.125), build3264);
    expect(row.cost).toBeCloseTo(3.9761, 4);
    expect('cachedRateMissing' in row).toBe(false);
  });

  it('keeps a provider-reported costUsd and sets no cachedRateMissing flag even with cache reads (#3284)', async () => {
    const row = await runWithUsage(cachedModels(), { ...build3264, costUsd: 0.05 });
    expect(row.cost).toBe(0.05);
    expect('cachedRateMissing' in row).toBe(false);
  });
});
