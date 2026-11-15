import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import type { RunPolicy } from '../run/policy.js';

const requires = ['claude', 'codex', 'command'] as const;
const stub = { tier: 'worker', description: 'stub' } as const;

export const WORKER_ROUTES: RoutesConfig = {
  version: 1,
  routes: Object.fromEntries(requires.map((r) => [`build_${r}`, { ...stub, requires: r }])),
};

const MODEL_ID = 'my-model';
const HARNESS_ID = 'my-agent';

const WORKER_MODEL_BASE = {
  provider: 'custom',
  tier: 'worker',
  contextWindow: 1000,
  capabilities: [],
  envKey: null,
} satisfies Partial<ModelsConfig['models'][string]>;

export const WORKER_MODELS: ModelsConfig = {
  version: 1,
  models: {
    [MODEL_ID]: { ...WORKER_MODEL_BASE, costPerMtokInput: 0, costPerMtokOutput: 0, harness: HARNESS_ID },
  },
  tiers: { worker: [MODEL_ID] },
  failover: { triggers: [], maxRetries: 0, cooldownMs: 0 },
  routingRules: {},
  harnesses: {
    [HARNESS_ID]: { command: `${HARNESS_ID} {model}`, prompt: 'stdin', output: 'stdout', agentic: true, usage: 'none' },
  },
};

const SANDBOX_LIMITS = { resources: { cpuMs: 0, memMb: 0 }, docker: { rolloutPercent: 0 } };
const SANDBOX_OFF: RunPolicy['sandbox'] = {
  enabled: false,
  runtime: 'auto',
  network: { allow: [] },
  ...SANDBOX_LIMITS,
};

export const workerPolicy: RunPolicy = {
  models: WORKER_MODELS,
  routes: WORKER_ROUTES,
  sandbox: SANDBOX_OFF,
  budget: {},
  effective: {} as RunPolicy['effective'],
};
