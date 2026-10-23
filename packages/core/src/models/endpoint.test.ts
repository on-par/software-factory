import { describe, expect, it } from 'vitest';

import type { ModelsConfig } from '../config/index.js';
import { diagnoseModels, ModelRegistry } from './index.js';

const config: ModelsConfig = {
  version: 1,
  models: {},
  tiers: {},
  failover: { triggers: [], maxRetries: 0, cooldownMs: 0 },
  routingRules: {},
};

describe('diagnoseModels claude-cli intermediary endpoint (#2906)', () => {
  const endpointConfig: ModelsConfig = {
    ...config,
    models: {
      'ds-or': {
        provider: 'custom',
        tier: 'worker',
        costPerMtokInput: 0,
        costPerMtokOutput: 0,
        contextWindow: 1000,
        capabilities: [],
        envKey: 'OPENROUTER_API_KEY',
        harness: 'claude-cli',
        claudeFlag: 'deepseek/deepseek-v4-flash',
        endpoint: 'https://openrouter.ai/api',
      },
    },
    tiers: { boss: [], worker: ['ds-or'], checker: [], triage: [] },
  };
  const diagnose = (probes: Parameters<typeof diagnoseModels>[1]) => {
    const d = diagnoseModels(new ModelRegistry(endpointConfig), probes).find((x) => x.model === 'ds-or');
    if (!d) throw new Error('missing');
    return d;
  };

  it('reports OPENROUTER_API_KEY not set instead of unsupported', () => {
    const d = diagnose({ commandAvailable: (c) => c === 'claude', envPresent: () => false });
    expect(d.reachable).toBe(false);
    expect(d.reason).toBe('OPENROUTER_API_KEY not set');
  });

  it('is ok via the intermediary host when the key is present', () => {
    const d = diagnose({ commandAvailable: (c) => c === 'claude', envPresent: () => true });
    expect(d.reachable).toBe(true);
    expect(d.reason).toBe('ok (claude CLI via openrouter.ai)');
  });

  it('reports a missing claude CLI', () => {
    const d = diagnose({ commandAvailable: () => false, envPresent: () => true });
    expect(d.reachable).toBe(false);
    expect(d.reason).toBe('claude CLI not found on PATH');
  });
});
