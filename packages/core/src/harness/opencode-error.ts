import { parseResetCooldownMs } from '../router/breaker.js';
import type { HarnessFailureReason } from './index.js';
import { failureKindFor, type ProviderFailure } from './provider-failure.js';

const DETAIL_LIMIT = 400;

export function parseOpenCodeResetAt(text: string, now: number): string | undefined {
  const ms = parseResetCooldownMs(text, 0, now);
  return ms === null ? undefined : new Date(now + ms).toISOString();
}

export function classifyOpenCodeFailure(reason: HarnessFailureReason, text: string, now: number): ProviderFailure {
  const kind = failureKindFor(reason, text);
  const resetAt = kind === 'usage_cap' || kind === 'rate_limit' ? parseOpenCodeResetAt(text, now) : undefined;
  return { kind, ...(resetAt ? { resetAt } : {}), reason, detail: text.trim().slice(0, DETAIL_LIMIT) };
}
