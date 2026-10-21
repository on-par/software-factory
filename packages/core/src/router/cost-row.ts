import type { HarnessFailureReason, HarnessUsage } from '../harness/index.js';
import { type ModelRegistry, priceUsage } from '../models/index.js';
import type { CostEntry, RetryCause, TaskType } from '../types/index.js';

/** Rough token estimate for cost accounting (~4 chars/token). Fallback only:
 *  used when the harness doesn't report real usage (claude-cli does; other
 *  harnesses don't yet, #424) — the resulting cost row is marked `estimated: true`. */
function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/** Build the cost row for one router attempt (the sink fills `issue`/`ts`). */
export function costRow(
  registry: Pick<ModelRegistry, 'estimateCost'>,
  row: {
    task: TaskType;
    model: string;
    prompt: string;
    output: string;
    failoverReason?: HarnessFailureReason;
    retryCause?: RetryCause;
    usage?: HarnessUsage;
    elapsedMs?: number;
  },
): Omit<CostEntry, 'ts' | 'issue'> {
  const { task, model, prompt, output, failoverReason, retryCause, usage, elapsedMs } = row;
  const inputTokens = usage?.inputTokens ?? estimateTokens(prompt);
  const outputTokens = usage?.outputTokens ?? estimateTokens(output);
  const { cost, flags } = priceUsage(registry, model, inputTokens, outputTokens, usage);
  return {
    task,
    model,
    inputTokens,
    outputTokens,
    cost,
    ...flags,
    estimated: usage === undefined,
    duration: elapsedMs ?? 0,
    ...(usage?.rawInputTokens !== undefined ? { rawInputTokens: usage.rawInputTokens } : {}),
    ...(usage?.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
    ...(usage?.cacheCreationTokens !== undefined ? { cacheCreationTokens: usage.cacheCreationTokens } : {}),
    ...(usage?.numTurns !== undefined ? { numTurns: usage.numTurns } : {}),
    ...(usage?.peakInputTokens !== undefined ? { peakInputTokens: usage.peakInputTokens } : {}),
    ...(usage?.contextWindow !== undefined ? { contextWindow: usage.contextWindow } : {}),
    ...(usage?.numTurns !== undefined &&
    usage.numTurns > 0 &&
    Number.isFinite(usage.numTurns) &&
    cost !== null &&
    Number.isFinite(cost)
      ? { costPerCallUsd: cost / usage.numTurns }
      : {}),
    ...(usage?.durationMs !== undefined ? { durationMs: usage.durationMs } : {}),
    ...(usage?.durationApiMs !== undefined ? { durationApiMs: usage.durationApiMs } : {}),
    ...(failoverReason ? { failoverReason } : {}),
    ...(retryCause ? { retryCause } : {}),
  };
}
