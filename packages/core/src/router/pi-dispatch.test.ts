import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import type { ExecFn } from './index.js';
import { CliModelExecutor, ModelRouter } from './index.js';

const routes: RoutesConfig = {
  version: 1,
  routes: { plan: { tier: 'boss', description: 'stub' } },
};

const piModels: ModelsConfig = {
  version: 1,
  models: {
    'pi-model': {
      provider: 'custom',
      tier: 'boss',
      costPerMtokInput: 3,
      costPerMtokOutput: 15,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
      harness: 'pi',
      providerModel: 'openrouter/deepseek/deepseek-v4-flash',
    },
  },
  tiers: { boss: ['pi-model'] },
  failover: {
    triggers: ['rate_limit', 'unavailable', 'auth'],
    maxRetries: 2,
    cooldownMs: 0,
  },
  routingRules: {},
};

describe('CliModelExecutor pi dispatch', () => {
  it('dispatches harness pi and records the Pi-reported costUsd in the CostEntry', async () => {
    const stdout = readFileSync(new URL('../__fixtures__/pi/success.jsonl', import.meta.url), 'utf8');
    const cmds: string[] = [];
    const execFn: ExecFn = async (cmd) => {
      cmds.push(cmd);
      return { stdout, stderr: '' };
    };
    const router = new ModelRouter(piModels, routes, false, new CliModelExecutor(execFn));
    const rows: Parameters<Parameters<ModelRouter['setCostSink']>[0]>[0][] = [];
    router.setCostSink((entry) => rows.push(entry));

    const result = await router.run('plan', 'do it');

    expect(result.output).toBe('Final answer');
    expect(cmds[0]).toMatch(/^pi -p --mode json /);
    expect(rows).toHaveLength(1);
    expect(rows[0].cost).toBeCloseTo(0.0042, 6);
    expect(rows[0].estimated).toBe(false);
  });
});
