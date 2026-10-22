// src/harness/codex-error.ts — pure Codex CLI limit-message adapter (#3227).
// Codex reports its usage limit as `try again in 1 days 2 hours 5 minutes` or `try again at 3:05 PM`;
// the absolute form is a wall-clock time in the box's IANA zone.

import { MAX_REPORTED_COOLDOWN_MS } from '../router/breaker.js';
import { zoneParts, zonedToUtc } from './claude-error.js';
import type { HarnessFailureReason } from './index.js';
import { failureKindForReason, type ProviderFailure } from './provider-failure.js';

const DETAIL_LIMIT = 400;
// "try again in 1 days 2 hours 5 minutes" — any subset, singular or plural, optional commas/"and".
const RELATIVE_RE = /try again in\s+((?:\d+\s*(?:days?|hours?|hrs?|minutes?|mins?)\b[\s,]*(?:and\s+)?)+)/i;
const UNIT_RE = /(\d+)\s*(day|hour|hr|min)/gi;
// "try again at 3:05 PM" — a bare wall-clock time in the box zone. A dated form doesn't match.
const ABSOLUTE_RE = /try again at\s+(\d{1,2}):(\d{2})\s*([ap])\.?m\.?(?![a-z])/i;

const UNIT_MS: Record<string, number> = { day: 86_400_000, hour: 3_600_000, hr: 3_600_000, min: 60_000 };

/** ISO instant of the reset Codex reported: `try again in <N> days <N> hours <N> minutes` (now + duration, capped at
 *  MAX_REPORTED_COOLDOWN_MS) or `try again at <h>:<mm> AM|PM` (next such wall-clock time in `timeZone`). Undefined
 *  when neither parses, the duration is zero, a field is out of range, or the zone is unknown. */
export function parseCodexResetAt(text: string, now: number, timeZone: string): string | undefined {
  try {
    const relative = RELATIVE_RE.exec(text);
    if (relative) {
      let total = 0;
      for (const unit of relative[1].matchAll(UNIT_RE)) total += Number(unit[1]) * UNIT_MS[unit[2].toLowerCase()];
      if (total === 0) return undefined;
      return new Date(now + Math.min(total, MAX_REPORTED_COOLDOWN_MS)).toISOString();
    }
    const absolute = ABSOLUTE_RE.exec(text);
    if (absolute) {
      const hour = Number(absolute[1]);
      const minute = Number(absolute[2]);
      if (hour < 1 || hour > 12 || minute > 59) return undefined;
      const h24 = (hour % 12) + (absolute[3].toLowerCase() === 'p' ? 12 : 0);
      const today = zoneParts(now, timeZone);
      let t = zonedToUtc(today.y, today.m, today.d, h24, minute, timeZone);
      if (t <= now) {
        const next = new Date(Date.UTC(today.y, today.m - 1, today.d + 1));
        t = zonedToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), h24, minute, timeZone);
      }
      return new Date(t).toISOString();
    }
  } catch {
    // Unknown IANA zone (Intl RangeError): no reset time, caller uses its default cooldown.
  }
  return undefined;
}

/** Maps a failure reason onto a ProviderFailure; the Codex login failure is kind `auth`, and resetAt is only
 *  reported for usage_cap and rate_limit. */
export function classifyCodexFailure(
  reason: HarnessFailureReason,
  text: string,
  now: number,
  timeZone: string,
): ProviderFailure {
  const kind = reason === 'local_auth' ? 'auth' : failureKindForReason(reason);
  const resetAt = kind === 'usage_cap' || kind === 'rate_limit' ? parseCodexResetAt(text, now, timeZone) : undefined;
  return { kind, ...(resetAt ? { resetAt } : {}), reason, detail: text.trim().slice(0, DETAIL_LIMIT) };
}

/** Error text codex emits on stdout under `--json`. Only error-bearing events are
 *  included — the agent transcript is excluded so that prose or command output
 *  mentioning a limit cannot manufacture a rate_limit/usage_cap verdict (#425). */
export function extractCodexErrorText(stdout: string): string {
  const messages: string[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) continue;
    const event = parsed as Record<string, unknown>;
    if (event.type === 'error' && typeof event.message === 'string') {
      messages.push(event.message);
    } else if (event.type === 'turn.failed') {
      const err = event.error as Record<string, unknown> | undefined;
      if (err && typeof err.message === 'string') messages.push(err.message);
    } else if (event.type === 'item.completed') {
      const item = event.item as Record<string, unknown> | undefined;
      if (item && item.type === 'error' && typeof item.message === 'string') messages.push(item.message);
    }
  }
  return messages.join('\n');
}
