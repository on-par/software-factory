// src/harness/opencode-error.ts — pure OpenCode Go cap adapter (#3336).
// OpenCode reports `Resets in 3hr 17min` or `resets at <ISO with Z/offset>`; the grammar lives in
// router/breaker.ts and is reused here so there is one owner.

import { parseResetCooldownMs } from '../router/breaker.js';
import type { HarnessFailureReason } from './index.js';
import { failureKindFor, type ProviderFailure } from './provider-failure.js';

const DETAIL_LIMIT = 400;

/** ISO instant of the reset OpenCode reported: `Resets in <h>hr <m>min` (now + duration) or
 *  `resets at <ISO>`, capped at MAX_REPORTED_COOLDOWN_MS. Undefined when neither parses or the
 *  instant is not after `now`. */
export function parseOpenCodeResetAt(text: string, now: number): string | undefined {
  const ms = parseResetCooldownMs(text, 0, now);
  return ms === null ? undefined : new Date(now + ms).toISOString();
}

/** Maps a failure reason onto a ProviderFailure; resetAt only for usage_cap and rate_limit. */
export function classifyOpenCodeFailure(reason: HarnessFailureReason, text: string, now: number): ProviderFailure {
  const kind = failureKindFor(reason, text);
  const resetAt = kind === 'usage_cap' || kind === 'rate_limit' ? parseOpenCodeResetAt(text, now) : undefined;
  return { kind, ...(resetAt ? { resetAt } : {}), reason, detail: text.trim().slice(0, DETAIL_LIMIT) };
}
