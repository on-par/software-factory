// src/harness/codex-error.ts — pure Codex CLI limit-message adapter (#3227).
// Codex words its ChatGPT-plan usage limit two ways: `try again in 1 days 2 hours 5 minutes` and
// `try again at 3:05 PM`. Parsing is a bounded token scan (indexOf + short slice + lookup tables), not a
// regex over the input, because CodeQL flagged regex-based parsing (js/polynomial-redos).

import { MAX_REPORTED_COOLDOWN_MS } from '../router/breaker.js';
import { zoneParts, zonedToUtc } from './claude-error.js';
import type { HarnessFailureReason } from './index.js';
import { failureKindFor, type ProviderFailure } from './provider-failure.js';

const DETAIL_LIMIT = 400;
/** Max characters examined after a phrase. */
const WINDOW = 80;

const UNIT_MS: Record<string, number> = {
  day: 86_400_000,
  days: 86_400_000,
  hour: 3_600_000,
  hours: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  minute: 60_000,
  minutes: 60_000,
  min: 60_000,
  mins: 60_000,
};

const RELATIVE = 'try again in ';
const ABSOLUTE = 'try again at ';

function parseRelative(lower: string, start: number, now: number): string | undefined {
  const tokens = lower.slice(start, start + WINDOW).split(/[\s,]+/);
  let total = 0;
  for (let t = 0; t < tokens.length; t++) {
    const token = tokens[t];
    if (token === 'and' || token === '') continue;
    if (!/^\d{1,6}$/.test(token)) break;
    const unit = (tokens[t + 1] ?? '').replace(/[.,;)]+$/, '');
    const ms = Object.hasOwn(UNIT_MS, unit) ? UNIT_MS[unit] : undefined;
    if (ms === undefined) break;
    total += Number(token) * ms;
    t++;
  }
  if (total === 0) return undefined;
  return new Date(now + Math.min(total, MAX_REPORTED_COOLDOWN_MS)).toISOString();
}

function parseAbsolute(lower: string, start: number, now: number, timeZone: string): string | undefined {
  const match = /^(\d{1,2}):(\d{2}) ?([ap])\.?m(?![a-z])/.exec(lower.slice(start, start + 12));
  if (!match) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 1 || hour > 12 || minute > 59) return undefined;
  const h24 = (hour % 12) + (match[3] === 'p' ? 12 : 0);
  const today = zoneParts(now, timeZone);
  let t = zonedToUtc(today.y, today.m, today.d, h24, minute, timeZone);
  if (t <= now) {
    const next = new Date(Date.UTC(today.y, today.m - 1, today.d + 1));
    t = zonedToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), h24, minute, timeZone);
  }
  return new Date(t).toISOString();
}

/** ISO instant Codex says the limit resets, from `try again in …` or `try again at h:mm AM|PM`. */
export function parseCodexResetAt(text: string, now: number, timeZone: string): string | undefined {
  try {
    const lower = text.toLowerCase();
    const i = lower.indexOf(RELATIVE);
    if (i >= 0) return parseRelative(lower, i + RELATIVE.length, now);
    const j = lower.indexOf(ABSOLUTE);
    if (j >= 0) return parseAbsolute(lower, j + ABSOLUTE.length, now, timeZone);
  } catch {
    // unknown IANA zone
  }
  return undefined;
}

/** Kind, reset time (usage_cap / rate_limit only) and detail for one Codex failure. */
export function classifyCodexFailure(
  reason: HarnessFailureReason,
  text: string,
  now: number,
  timeZone: string,
): ProviderFailure {
  const kind = failureKindFor(reason, text);
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
