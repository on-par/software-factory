import { describe, expect, it, vi } from 'vitest';
import { ModelRegistry } from '../models/index.js';
import { buildStewardCostEntry } from './diagnose.js';

describe('steward cached input pricing', () => {
  it('passes cache reads to the registry and flags full-input fallback', () => {
    const estimate = vi.spyOn(ModelRegistry.prototype, 'estimateCost');
    const entry = buildStewardCostEntry('claude-opus-5', 7, 'p', {
      text: 'r',
      usage: { inputTokens: 1000, outputTokens: 0, cacheReadTokens: 500 },
    });
    expect(estimate).toHaveBeenCalledWith('claude-opus-5', {
      inputTokens: 1000,
      outputTokens: 0,
      cacheReadTokens: 500,
    });
    expect(entry.cachedRateMissing).toBe(true);
    estimate.mockRestore();
  });

  it('preserves reported zero cost without invoking the estimator', () => {
    const estimate = vi.spyOn(ModelRegistry.prototype, 'estimateCost');
    const entry = buildStewardCostEntry('claude-opus-5', 7, 'p', {
      text: 'r',
      usage: { inputTokens: 1000, outputTokens: 0, cacheReadTokens: 500, costUsd: 0 },
    });
    expect(entry.cost).toBe(0);
    expect(entry).not.toHaveProperty('cachedRateMissing');
    expect(estimate).not.toHaveBeenCalled();
    estimate.mockRestore();
  });
});
