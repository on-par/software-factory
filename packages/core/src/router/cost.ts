import type { HarnessUsage } from '../harness/index.js';
import type { ModelRegistry } from '../models/index.js';

export function estimateUsageCost(
  registry: ModelRegistry,
  model: string,
  inputTokens: number,
  outputTokens: number,
  usage?: HarnessUsage,
): { cost: number | null; cachedRateMissing: boolean } {
  if (usage?.costUsd !== undefined && usage.costUsd !== null) {
    return { cost: usage.costUsd, cachedRateMissing: false };
  }
  return registry.estimateCost(model, { inputTokens, outputTokens, cacheReadTokens: usage?.cacheReadTokens });
}
