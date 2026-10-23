import { describe, expect, it, vi } from 'vitest';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { HarnessError } from '../harness/index.js';
import { ModelRouter } from './index.js';

const models: ModelsConfig = {
  version: 1,
  models: {
    'oc-model': {
      provider: 'custom',
      tier: 'boss',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
      harness: 'opencode',
    },
  },
  tiers: { boss: ['oc-model'] },
  failover: {
    triggers: ['rate_limit', 'unavailable', 'auth'],
    maxRetries: 2,
    cooldownMs: 0,
  },
  routingRules: {},
};

const routes: RoutesConfig = { version: 1, routes: { plan: { tier: 'boss', description: 'stub' } } };

describe('router local-auth sink for opencode (#2890)', () => {
  it('reports an opencode local_auth failure to the local-auth sink as opencode', async () => {
    const router = new ModelRouter(models, routes, false, {
      runModel: async () => {
        throw new HarnessError('401 unauthorized', 'local_auth');
      },
    });
    const sink = vi.fn();
    router.setLocalAuthSink(sink);
    await expect(router.run('plan', 'plan')).rejects.toBeDefined();
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledWith('opencode');
  });
});
