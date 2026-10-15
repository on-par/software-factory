import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import type { CostEntry } from '../types/index.js';
import type { ExecFn } from './index.js';
import { CliModelExecutor, ModelRouter } from './index.js';

const routes: RoutesConfig = { version: 1, routes: { plan: { tier: 'boss', description: 'stub' } } };

describe('claude-cli endpoint pricing (#2907)', () => {
  const base = { tier: 'boss', contextWindow: 1000, capabilities: [] as string[] };
  const modelsFor = (name: string): ModelsConfig => ({
    version: 1,
    models: {
      'or-model': {
        ...base,
        provider: 'custom',
        harness: 'claude-cli',
        endpoint: 'https://openrouter.ai/api',
        envKey: 'OPENROUTER_API_KEY',
        claudeFlag: 'deepseek/deepseek-v4-flash',
        costPerMtokInput: 0.3,
        costPerMtokOutput: 1.2,
      },
      'claude-sonnet-5': {
        ...base,
        provider: 'anthropic',
        envKey: null,
        claudeFlag: 'claude-sonnet-5',
        costPerMtokInput: 3,
        costPerMtokOutput: 15,
      },
    },
    tiers: { boss: [name] },
    failover: {
      triggers: ['rate_limit', 'usage_cap', 'timeout', 'error', 'empty_response'],
      maxRetries: 2,
      cooldownMs: 0,
      escalateAfterTierExhausted: true,
    },
    routingRules: {},
  });
  const execWith =
    (cost: number): ExecFn =>
    async () => ({
      stdout: [
        JSON.stringify({ type: 'system', subtype: 'init' }),
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'OUT',
          total_cost_usd: cost,
          usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
        }),
      ].join('\n'),
      stderr: '',
    });

  afterEach(() => vi.unstubAllEnvs());

  async function costRows(model: string, cost: number) {
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-test');
    const router = new ModelRouter(modelsFor(model), routes, false, new CliModelExecutor(execWith(cost)));
    const rows: CostEntry[] = [];
    router.setCostSink((entry) => rows.push({ ...entry, ts: '', issue: '' }));
    await router.run('plan', 'p');
    return rows;
  }

  it('prices a claude-cli endpoint call from registry prices, not total_cost_usd (#2907)', async () => {
    const rows = await costRows('or-model', 9.99);
    expect(rows).toHaveLength(1);
    expect(rows[0].model).toBe('or-model');
    expect(rows[0].cost).toBeCloseTo(1.5);
    expect(rows[0].inputTokens).toBe(1_000_000);
    expect(rows[0].outputTokens).toBe(1_000_000);
    expect(rows[0].estimated).toBe(false);
    expect(rows[0].unpriced).toBeUndefined();
  });

  it('keeps total_cost_usd as the cost of a claude-cli call with no endpoint (#2907)', async () => {
    const rows = await costRows('claude-sonnet-5', 0.42);
    expect(rows).toHaveLength(1);
    expect(rows[0].cost).toBeCloseTo(0.42);
  });
});
