import { describe, expect, it } from 'vitest';

import type { ModelsConfig } from '../config/index.js';
import { diagnoseModels, ModelRegistry } from './index.js';

const config: ModelsConfig = {
  version: 1,
  models: {
    'opencode-model': {
      provider: 'custom',
      tier: 'worker',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
      harness: 'opencode',
      providerModel: 'anthropic/claude-sonnet-5',
    },
  },
  tiers: { worker: ['opencode-model'] },
  failover: {
    triggers: ['rate_limit', 'unavailable', 'auth'],
    maxRetries: 2,
    cooldownMs: 0,
  },
  routingRules: {},
};

describe('models --doctor opencode local_auth (#2890)', () => {
  it('marks an opencode model unreachable when its last run hit local_auth with no login since', () => {
    const [d] = diagnoseModels(
      new ModelRegistry(config),
      {
        commandAvailable: (cmd) => cmd === 'opencode',
        envPresent: () => false,
        opencodeLoggedIn: () => true,
        localAuthFailure: (a) => (a === 'opencode' ? { agent: a, at: '2026-10-14T09:00:00.000Z' } : null),
      },
      true,
    );
    expect(d!.reachable).toBe(false);
    expect(d!.reason).toContain('re-run opencode auth login');
    expect(d!.reason).toContain('2026-10-14T09:00:00.000Z');
  });
});
