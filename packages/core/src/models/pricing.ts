import type { ModelDefinition } from '../types/index.js';

export function estimateModelCost(
  def: ModelDefinition | undefined,
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number },
): { cost: number | null; cachedRateMissing: boolean } {
  if (!def) return { cost: null, cachedRateMissing: false };
  const requested = usage.cacheReadTokens ?? 0;
  const cached = Number.isFinite(requested) ? Math.min(Math.max(0, requested), Math.max(0, usage.inputTokens)) : 0;
  const cachedRateMissing = cached > 0 && def.costPerMtokCachedInput === undefined;
  return {
    cost:
      ((usage.inputTokens - cached) * def.costPerMtokInput +
        cached * (def.costPerMtokCachedInput ?? def.costPerMtokInput) +
        usage.outputTokens * def.costPerMtokOutput) /
      1_000_000,
    cachedRateMissing,
  };
}
