// src/models/cost.ts — Token-based cost estimation, shared by the router and the steward (#3284)

import type { CostEntry, ModelDefinition } from '../types/index.js';
import type { ModelRegistry } from './index.js';

export interface CostTokens {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
}

export interface CostEstimate {
  cost: number | null;
  cachedRateMissing: boolean;
}

/** Price tokens for a registered model. Cache reads (clamped to 0..inputTokens) use costPerMtokCachedInput,
 *  or costPerMtokInput with cachedRateMissing when the model sets none. */
export function computeCost(def: ModelDefinition, tokens: CostTokens): CostEstimate {
  const raw = tokens.cacheReadTokens;
  const cached = raw !== undefined && Number.isFinite(raw) ? Math.min(Math.max(raw, 0), tokens.inputTokens) : 0;
  const cachedRate = def.costPerMtokCachedInput ?? def.costPerMtokInput;
  const cost =
    ((tokens.inputTokens - cached) / 1_000_000) * def.costPerMtokInput +
    (cached / 1_000_000) * cachedRate +
    (tokens.outputTokens / 1_000_000) * def.costPerMtokOutput;
  return { cost, cachedRateMissing: cached > 0 && def.costPerMtokCachedInput === undefined };
}

/** Cost and cost-row flags for one call: a provider-reported costUsd wins and is never flagged; otherwise estimate. */
export function priceUsage(
  registry: Pick<ModelRegistry, 'estimateCost'>,
  model: string,
  inputTokens: number,
  outputTokens: number,
  usage: { cacheReadTokens?: number; costUsd?: number } | undefined,
): { cost: number | null; flags: Pick<CostEntry, 'unpriced' | 'cachedRateMissing'> } {
  if (usage?.costUsd !== undefined) return { cost: usage.costUsd, flags: {} };
  const est = registry.estimateCost(model, { inputTokens, outputTokens, cacheReadTokens: usage?.cacheReadTokens });
  return {
    cost: est.cost,
    flags: {
      ...(est.cost === null ? { unpriced: true } : {}),
      ...(est.cachedRateMissing ? { cachedRateMissing: true } : {}),
    },
  };
}
