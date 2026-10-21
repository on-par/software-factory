import { describe, expect, it } from 'vitest';

import { costRow } from './cost-row.js';

const registry = {
  estimateCost: (_model: string, t: { inputTokens: number; outputTokens: number }) => ({
    cost: (t.inputTokens * 3 + t.outputTokens * 15) / 1_000_000,
    cachedRateMissing: false,
  }),
};

describe('costRow', () => {
  it('estimates tokens from the text and marks the row estimated without usage', () => {
    const row = costRow(registry, { task: 'plan', model: 'm', prompt: 'abcdefgh', output: '' });
    expect(row).toMatchObject({
      task: 'plan',
      model: 'm',
      inputTokens: 2,
      outputTokens: 1,
      estimated: true,
      duration: 0,
    });
    expect(row.cost).toBeGreaterThan(0);
    expect(row.costPerCallUsd).toBeUndefined();
  });

  it('uses reported usage, cache fields, per-call cost and failover/retry markers', () => {
    const row = costRow(registry, {
      task: 'build_codex',
      model: 'm',
      prompt: 'p',
      output: 'o',
      failoverReason: 'rate_limit',
      retryCause: 'checker',
      elapsedMs: 42,
      usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 5, numTurns: 2 },
    });
    expect(row).toMatchObject({
      inputTokens: 1000,
      outputTokens: 100,
      estimated: false,
      duration: 42,
      cacheReadTokens: 5,
      numTurns: 2,
      failoverReason: 'rate_limit',
      retryCause: 'checker',
    });
    expect(row.costPerCallUsd).toBeCloseTo((row.cost as number) / 2);
  });
});
