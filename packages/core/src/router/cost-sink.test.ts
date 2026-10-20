import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createTempDirs } from '@on-par/factory-core/testing';
import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import type { CostEntry } from '../types/index.js';
import { aggregateCosts, readCostsFile } from '../usage/index.js';
import { ModelRouter } from './index.js';
import { StubModelExecutor } from './stub.js';

const routes: RoutesConfig = {
  version: 1,
  routes: { plan: { tier: 'boss', description: 'stub' }, build_claude: { tier: 'boss', description: 'stub' } },
};
type CostRowInput = Parameters<Parameters<ModelRouter['setCostSink']>[0]>[0];

describe('ModelRouter cost sink', () => {
  const costModels: ModelsConfig = {
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
      triggers: ['rate_limit', 'usage_cap', 'timeout', 'error', 'empty_response'],
      maxRetries: 2,
      cooldownMs: 0,
      escalateAfterTierExhausted: true,
    },
    routingRules: {},
  };

  // Two providers, for the same reason twoModels above uses two: a failover
  // assertion cannot be written against a same-provider pair since #554.
  const costTwoModels: ModelsConfig = {
    version: 1,
    models: {
      'model-a': {
        provider: 'anthropic',
        tier: 'boss',
        costPerMtokInput: 3,
        costPerMtokOutput: 15,
        contextWindow: 1000,
        capabilities: [],
        envKey: null,
      },
      'model-b': {
        provider: 'openai',
        tier: 'boss',
        costPerMtokInput: 3,
        costPerMtokOutput: 15,
        contextWindow: 1000,
        capabilities: [],
        envKey: null,
      },
    },
    tiers: { boss: ['model-a', 'model-b'] },
    failover: {
      triggers: ['rate_limit', 'usage_cap', 'timeout', 'error', 'empty_response'],
      maxRetries: 2,
      cooldownMs: 0,
      escalateAfterTierExhausted: true,
    },
    routingRules: {},
  };

  it('records exactly one cost row for a successful run', async () => {
    const stub = new StubModelExecutor({ scripts: { plan: [{ output: 'SCRIPTED PLAN' }] } });
    const router = new ModelRouter(costModels, routes, false, stub);
    const rows: Parameters<Parameters<ModelRouter['setCostSink']>[0]>[0][] = [];
    router.setCostSink((entry) => rows.push(entry));

    await router.run('plan', 'do it');

    expect(rows).toHaveLength(1);
    expect(rows[0].task).toBe('plan');
    expect(rows[0].model).toBe('stub-model');
    expect(rows[0].inputTokens).toBeGreaterThan(0);
    expect(rows[0].outputTokens).toBeGreaterThan(0);
    expect(rows[0].cost).toBeGreaterThan(0);
    expect(rows[0].unpriced).toBeUndefined();
    expect(rows[0].estimated).toBe(true);
    expect(rows[0].numTurns).toBeUndefined();
    expect(rows[0].durationMs).toBeUndefined();
    expect(rows[0].durationApiMs).toBeUndefined();
    expect(rows[0].rawInputTokens).toBeUndefined();
    expect(rows[0].cacheReadTokens).toBeUndefined();
    expect(rows[0].cacheCreationTokens).toBeUndefined();
    expect(typeof rows[0].duration).toBe('number');
    expect(rows[0].duration).toBeGreaterThanOrEqual(0);
  });

  it('records an unpriced row (cost null) when the model has no known price', async () => {
    const stub = new StubModelExecutor({
      scripts: {
        plan: [
          { output: 'SCRIPTED PLAN', effect: (ctx) => ctx.onUsage?.({ inputTokens: 1, outputTokens: 1, numTurns: 2 }) },
        ],
      },
    });
    const router = new ModelRouter(costModels, routes, false, stub);
    vi.spyOn(router.registryRef, 'estimateCost').mockReturnValue(null);
    const rows: Parameters<Parameters<ModelRouter['setCostSink']>[0]>[0][] = [];
    router.setCostSink((entry) => rows.push(entry));

    await router.run('plan', 'do it');

    expect(rows).toHaveLength(1);
    expect(rows[0].cost).toBeNull();
    expect(rows[0].unpriced).toBe(true);
    expect(rows[0].costPerCallUsd).toBeUndefined();
    expect(rows[0].numTurns).toBe(2);
  });

  it('derives a per-call average for valid counts including zero cost', async () => {
    const stub = new StubModelExecutor({
      scripts: {
        plan: [
          { output: 'X', effect: (ctx) => ctx.onUsage?.({ inputTokens: 1, outputTokens: 1, costUsd: 0, numTurns: 2 }) },
        ],
      },
    });
    const router = new ModelRouter(costModels, routes, false, stub);
    const rows: CostRowInput[] = [];
    router.setCostSink((entry) => rows.push(entry));
    await router.run('plan', 'p');
    expect(rows[0].costPerCallUsd).toBe(0);
  });

  it('omits per-call average when the final cost is non-finite', async () => {
    const stub = new StubModelExecutor({
      scripts: {
        plan: [
          {
            output: 'X',
            effect: (ctx) =>
              ctx.onUsage?.({ inputTokens: 1, outputTokens: 1, costUsd: Number.POSITIVE_INFINITY, numTurns: 2 }),
          },
        ],
      },
    });
    const router = new ModelRouter(costModels, routes, false, stub);
    const rows: CostRowInput[] = [];
    router.setCostSink((entry) => rows.push(entry));
    await router.run('plan', 'p');
    expect(rows[0].cost).toBe(Number.POSITIVE_INFINITY);
    expect(rows[0].costPerCallUsd).toBeUndefined();
  });

  it.each([undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'omits per-call average for invalid or missing count %s',
    async (numTurns) => {
      const stub = new StubModelExecutor({
        scripts: {
          plan: [
            {
              output: 'X',
              effect: (ctx) =>
                ctx.onUsage?.({
                  inputTokens: 1,
                  outputTokens: 1,
                  costUsd: 0.1,
                  ...(numTurns !== undefined ? { numTurns } : {}),
                }),
            },
          ],
        },
      });
      const router = new ModelRouter(costModels, routes, false, stub);
      const rows: CostRowInput[] = [];
      router.setCostSink((entry) => rows.push(entry));
      await router.run('plan', 'p');
      expect(rows[0].costPerCallUsd).toBeUndefined();
      expect(rows[0].peakInputTokens).toBeUndefined();
      expect(rows[0].contextWindow).toBeUndefined();
    },
  );

  it('keeps a harness-reported costUsd priced even when the model has no known price', async () => {
    const stub = new StubModelExecutor({
      scripts: {
        plan: [{ output: 'X', effect: (ctx) => ctx.onUsage?.({ inputTokens: 10, outputTokens: 5, costUsd: 0.05 }) }],
      },
    });
    const router = new ModelRouter(costModels, routes, false, stub);
    vi.spyOn(router.registryRef, 'estimateCost').mockReturnValue(null);
    const rows: Parameters<Parameters<ModelRouter['setCostSink']>[0]>[0][] = [];
    router.setCostSink((entry) => rows.push(entry));

    await router.run('plan', 'do it');

    expect(rows[0].cost).toBe(0.05);
    expect('unpriced' in rows[0]).toBe(false);
  });

  it('records real usage and marks estimated false when the harness reports it', async () => {
    const stub = new StubModelExecutor({
      scripts: {
        plan: [
          {
            output: 'SCRIPTED PLAN',
            effect: (ctx) =>
              ctx.onUsage?.({
                inputTokens: 1200,
                outputTokens: 340,
                costUsd: 0.05,
                rawInputTokens: 100,
                cacheReadTokens: 1000,
                cacheCreationTokens: 100,
                numTurns: 7,
                peakInputTokens: 198303,
                contextWindow: 272000,
                durationMs: 60000,
                durationApiMs: 55000,
              }),
          },
        ],
      },
    });
    const router = new ModelRouter(costModels, routes, false, stub);
    const rows: Parameters<Parameters<ModelRouter['setCostSink']>[0]>[0][] = [];
    router.setCostSink((entry) => rows.push(entry));

    await router.run('plan', 'do it');

    expect(rows).toHaveLength(1);
    expect(rows[0].inputTokens).toBe(1200);
    expect(rows[0].outputTokens).toBe(340);
    expect(rows[0].cost).toBe(0.05);
    expect(rows[0].estimated).toBe(false);
    expect(rows[0].rawInputTokens).toBe(100);
    expect(rows[0].cacheReadTokens).toBe(1000);
    expect(rows[0].cacheCreationTokens).toBe(100);
    expect(rows[0].numTurns).toBe(7);
    expect(rows[0].peakInputTokens).toBe(198303);
    expect(rows[0].contextWindow).toBe(272000);
    expect(rows[0].costPerCallUsd).toBe(0.05 / 7);
    expect(rows[0].durationMs).toBe(60000);
    expect(rows[0].durationApiMs).toBe(55000);
  });

  it('falls back to registry cost estimation when real usage lacks costUsd', async () => {
    const stub = new StubModelExecutor({
      scripts: {
        plan: [
          {
            output: 'SCRIPTED PLAN',
            effect: (ctx) => ctx.onUsage?.({ inputTokens: 1000, outputTokens: 500 }),
          },
        ],
      },
    });
    const router = new ModelRouter(costModels, routes, false, stub);
    const rows: Parameters<Parameters<ModelRouter['setCostSink']>[0]>[0][] = [];
    router.setCostSink((entry) => rows.push(entry));

    await router.run('plan', 'do it');

    expect(rows).toHaveLength(1);
    expect(rows[0].inputTokens).toBe(1000);
    expect(rows[0].outputTokens).toBe(500);
    expect(rows[0].cost).toBeCloseTo(0.0105, 10);
    expect(rows[0].estimated).toBe(false);
  });

  it('does not record a cost row when all models fail', async () => {
    const stub = new StubModelExecutor({
      scripts: { plan: [{ fail: 'error' }, { fail: 'error' }, { fail: 'error' }] },
    });
    const router = new ModelRouter(costModels, routes, false, stub);
    const rows: unknown[] = [];
    router.setCostSink((entry) => rows.push(entry));

    await expect(router.run('plan', 'do it')).rejects.toThrow();

    expect(rows).toEqual([]);
  });

  it('records failoverReason on the row when a failover occurred', async () => {
    const stub = new StubModelExecutor({
      scripts: {
        plan: [{ fail: 'usage_cap' }, { output: 'FROM B' }],
      },
    });
    const router = new ModelRouter(costTwoModels, routes, false, stub);
    const rows: Parameters<Parameters<ModelRouter['setCostSink']>[0]>[0][] = [];
    router.setCostSink((entry) => rows.push(entry));

    const result = await router.run('plan', 'do it');

    expect(result.model).toBe('model-b');
    expect(rows).toHaveLength(1);
    expect(rows[0].model).toBe('model-b');
    expect(rows[0].failoverReason).toBe('usage_cap');
  });

  it('carries real usage through a failover onto the successful attempt row', async () => {
    const stub = new StubModelExecutor({
      scripts: {
        plan: [
          { fail: 'usage_cap' },
          {
            output: 'FROM B',
            effect: (ctx) => ctx.onUsage?.({ inputTokens: 10, outputTokens: 20 }),
          },
        ],
      },
    });
    const router = new ModelRouter(costTwoModels, routes, false, stub);
    const rows: Parameters<Parameters<ModelRouter['setCostSink']>[0]>[0][] = [];
    router.setCostSink((entry) => rows.push(entry));

    const result = await router.run('plan', 'do it');

    expect(result.model).toBe('model-b');
    expect(rows).toHaveLength(1);
    expect(rows[0].failoverReason).toBe('usage_cap');
    expect(rows[0].inputTokens).toBe(10);
    expect(rows[0].estimated).toBe(false);
  });

  it('records estimated false with the failoverReason when the winning attempt reports codex-shaped usage (AC 1 + verification bullet 3)', async () => {
    const stub = new StubModelExecutor({
      scripts: {
        plan: [
          { fail: 'usage_cap' },
          {
            output: 'FROM B',
            effect: (ctx) =>
              ctx.onUsage?.({
                inputTokens: 15785,
                outputTokens: 5,
                rawInputTokens: 5801,
                cacheReadTokens: 9984,
              }),
          },
        ],
      },
    });
    const router = new ModelRouter(costTwoModels, routes, false, stub);
    const rows: Parameters<Parameters<ModelRouter['setCostSink']>[0]>[0][] = [];
    router.setCostSink((entry) => rows.push(entry));

    const result = await router.run('plan', 'do it');

    expect(result.model).toBe('model-b');
    expect(rows).toHaveLength(1);
    expect(rows[0].failoverReason).toBe('usage_cap');
    expect(rows[0].estimated).toBe(false);
    expect(rows[0].inputTokens).toBe(15785);
    expect(rows[0].outputTokens).toBe(5);
    expect(rows[0].rawInputTokens).toBe(5801);
    expect(rows[0].cacheReadTokens).toBe(9984);
    expect(rows[0].numTurns).toBeUndefined();
    expect(rows[0].peakInputTokens).toBeUndefined();
    expect(rows[0].contextWindow).toBeUndefined();
    expect(rows[0].costPerCallUsd).toBeUndefined();
  });

  it('does not leak usage reported by a failed attempt onto the next attempt row', async () => {
    const stub = new StubModelExecutor({
      scripts: {
        plan: [
          {
            fail: 'usage_cap',
            effect: (ctx) => ctx.onUsage?.({ inputTokens: 999, outputTokens: 999 }),
          },
          { output: 'FROM B' },
        ],
      },
    });
    const router = new ModelRouter(costTwoModels, routes, false, stub);
    const rows: Parameters<Parameters<ModelRouter['setCostSink']>[0]>[0][] = [];
    router.setCostSink((entry) => rows.push(entry));

    await router.run('plan', 'do it');

    expect(rows).toHaveLength(1);
    expect(rows[0].estimated).toBe(true);
  });

  it('records retryCause on the row when the caller passes options.retryCause', async () => {
    const stub = new StubModelExecutor({ scripts: { plan: [{ output: 'SCRIPTED PLAN' }] } });
    const router = new ModelRouter(costModels, routes, false, stub);
    const rows: Parameters<Parameters<ModelRouter['setCostSink']>[0]>[0][] = [];
    router.setCostSink((entry) => rows.push(entry));

    await router.run('plan', 'do it', { retryCause: 'checker' });

    expect(rows).toHaveLength(1);
    expect(rows[0].retryCause).toBe('checker');
  });

  it('omits retryCause from the row when the caller does not pass it', async () => {
    const stub = new StubModelExecutor({ scripts: { plan: [{ output: 'SCRIPTED PLAN' }] } });
    const router = new ModelRouter(costModels, routes, false, stub);
    const rows: Parameters<Parameters<ModelRouter['setCostSink']>[0]>[0][] = [];
    router.setCostSink((entry) => rows.push(entry));

    await router.run('plan', 'do it');

    expect(rows).toHaveLength(1);
    expect('retryCause' in rows[0]).toBe(false);
  });

  it('reads and aggregates claude-shaped and codex-shaped cost rows through one schema, no route branch (AC 2)', async () => {
    const tempDirs = createTempDirs();
    const dir = await tempDirs.make('factory-costs-');
    const file = join(dir, 'costs.jsonl');
    try {
      const claudeRow: CostEntry = {
        ts: '2026-08-12T00:00:00.000Z',
        issue: '425',
        task: 'plan',
        model: 'claude-model',
        inputTokens: 12 + 4500 + 230000,
        outputTokens: 890,
        cost: 0.0123,
        estimated: false,
        rawInputTokens: 12,
        cacheReadTokens: 230000,
        cacheCreationTokens: 4500,
      };
      const codexRow: CostEntry = {
        ts: '2026-08-12T00:00:01.000Z',
        issue: '425',
        task: 'build_codex',
        model: 'codex-model',
        inputTokens: 15785,
        outputTokens: 5,
        cost: 0.02,
        estimated: false,
        rawInputTokens: 5801,
        cacheReadTokens: 9984,
        numTurns: 3,
        peakInputTokens: 198303,
        contextWindow: 272000,
        costPerCallUsd: 0.006,
      };
      await writeFile(file, `${JSON.stringify(claudeRow)}\n${JSON.stringify(codexRow)}\n`);

      const { entries, skipped } = readCostsFile(file);

      expect(skipped).toBe(0);
      expect(entries).toHaveLength(2);
      expect(entries[1]).toMatchObject({
        numTurns: 3,
        peakInputTokens: 198303,
        contextWindow: 272000,
        costPerCallUsd: 0.006,
      });

      const summary = aggregateCosts(entries);

      expect(summary.total.inputTokens).toBe(claudeRow.inputTokens + codexRow.inputTokens);
      expect(summary.total.outputTokens).toBe(claudeRow.outputTokens + codexRow.outputTokens);
      expect(summary.total.cost).toBeCloseTo((claudeRow.cost ?? 0) + (codexRow.cost ?? 0), 10);
    } finally {
      await tempDirs.cleanup();
    }
  });
});
