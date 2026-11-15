import { describe, expect, it } from 'vitest';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import type { RunPolicy } from '../run/policy.js';

export const WORKER_ROUTES: RoutesConfig = {
  version: 1,
  routes: {
    build_claude: { tier: 'worker', description: 'stub', requires: 'claude' },
    build_codex: { tier: 'worker', description: 'stub', requires: 'codex' },
    build_command: { tier: 'worker', description: 'stub', requires: 'command' },
  },
};
export const WORKER_MODELS: ModelsConfig = {
  version: 1,
  models: {
    'my-model': {
      provider: 'custom',
      tier: 'worker',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
      harness: 'my-agent',
    },
  },
  tiers: { worker: ['my-model'] },
  failover: { triggers: [], maxRetries: 0, cooldownMs: 0 },
  routingRules: {},
  harnesses: {
    'my-agent': { command: 'my-agent {model}', prompt: 'stdin', output: 'stdout', agentic: true, usage: 'none' },
  },
};
export const workerPolicy: RunPolicy = {
  models: WORKER_MODELS,
  routes: WORKER_ROUTES,
  sandbox: {
    enabled: false,
    runtime: 'auto',
    network: { allow: [] },
    resources: { cpuMs: 0, memMb: 0 },
    docker: { rolloutPercent: 0 },
  },
  budget: {},
  effective: {} as RunPolicy['effective'],
};

describe('worker policy fixture', () => {
  it('routes every build route to a tier the models config defines', () => {
    const tiers = Object.keys(WORKER_MODELS.tiers);
    for (const route of Object.values(WORKER_ROUTES.routes)) expect(tiers).toContain(route.tier);
    expect(workerPolicy.models).toBe(WORKER_MODELS);
    expect(workerPolicy.routes).toBe(WORKER_ROUTES);
  });
});
