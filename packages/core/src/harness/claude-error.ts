// src/harness/claude-error.ts — pure Claude Code limit-message adapter (#3225).
// Claude prints its weekly cap as `resets Oct 20 at 7am (America/Chicago)` and its 5-hour cap as
// `resets 7am (America/Chicago)`; both are wall-clock times in the named IANA zone.

import { classifyFailure } from './classify.js';
import type { HarnessFailureReason } from './index.js';
import { failureKindFor, type ProviderFailure } from './provider-failure.js';

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const WEEKLY_RE = /resets\s+([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)\s]+)\)/i;
const TIME_RE = /resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)\s]+)\)/i;
const LIMIT_RE = /hit your (?:weekly |session |5-hour )?limit|usage limit reached/i;
const DETAIL_LIMIT = 400;
const DAY_MS = 24 * 60 * 60_000;

function zoneFormatter(zone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  });
}

function zoneParts(
  utcMs: number,
  zone: string,
): { y: number; m: number; d: number; h: number; min: number; s: number } {
  const out: Record<string, number> = {};
  for (const part of zoneFormatter(zone).formatToParts(new Date(utcMs))) {
    if (part.type !== 'literal') out[part.type] = Number(part.value);
  }
  return { y: out.year, m: out.month, d: out.day, h: out.hour % 24, min: out.minute, s: out.second };
}

function zoneOffsetMs(utcMs: number, zone: string): number {
  const p = zoneParts(utcMs, zone);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - Math.floor(utcMs / 1000) * 1000;
}

/** UTC ms of the wall-clock time y-m-d h:min in `zone`; the second pass settles DST transitions. */
function zonedToUtc(y: number, m: number, d: number, h: number, min: number, zone: string): number {
  const guess = Date.UTC(y, m - 1, d, h, min);
  const first = guess - zoneOffsetMs(guess, zone);
  return guess - zoneOffsetMs(first, zone);
}

function to24h(hour: number, meridiem: string): number {
  const pm = meridiem.toLowerCase() === 'pm';
  return (hour % 12) + (pm ? 12 : 0);
}

/** ISO instant of the reset time named in Claude limit `text`, resolved against `now` (ms). Undefined when the
 *  text has no reset wording, a field is out of range, or the zone is unknown. */
export function parseClaudeResetAt(text: string, now: number): string | undefined {
  try {
    const weekly = WEEKLY_RE.exec(text);
    if (weekly) {
      const month = MONTHS.indexOf(weekly[1].toLowerCase()) + 1;
      const day = Number(weekly[2]);
      const hour = Number(weekly[3]);
      const minute = weekly[4] ? Number(weekly[4]) : 0;
      if (month < 1 || day < 1 || day > 31 || hour < 1 || hour > 12 || minute > 59) return undefined;
      const zone = weekly[6];
      const year = zoneParts(now, zone).y;
      const h24 = to24h(hour, weekly[5]);
      let t = zonedToUtc(year, month, day, h24, minute, zone);
      if (t < now - DAY_MS) t = zonedToUtc(year + 1, month, day, h24, minute, zone);
      return new Date(t).toISOString();
    }
    const timeOnly = TIME_RE.exec(text);
    if (timeOnly) {
      const hour = Number(timeOnly[1]);
      const minute = timeOnly[2] ? Number(timeOnly[2]) : 0;
      if (hour < 1 || hour > 12 || minute > 59) return undefined;
      const zone = timeOnly[4];
      const h24 = to24h(hour, timeOnly[3]);
      const today = zoneParts(now, zone);
      let t = zonedToUtc(today.y, today.m, today.d, h24, minute, zone);
      if (t <= now) {
        const next = new Date(Date.UTC(today.y, today.m - 1, today.d + 1));
        t = zonedToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), h24, minute, zone);
      }
      return new Date(t).toISOString();
    }
  } catch {
    // Unknown IANA zone (Intl RangeError): no reset time, caller uses its default cooldown.
  }
  return undefined;
}

/** Classifies Claude failure text (stderr/stream diagnostics on a non-zero exit, or the `is_error` result text on
 *  exit 0) into a ProviderFailure. `zeroTokenResult` marks a zero-token, zero-API-duration result. */
export function classifyClaudeFailure(
  text: string,
  exitCode: number,
  now: number,
  opts: { zeroTokenResult?: boolean } = {},
): ProviderFailure {
  const detail = text.trim().slice(0, DETAIL_LIMIT);
  const resetAt = parseClaudeResetAt(text, now);
  if (resetAt || LIMIT_RE.test(text)) {
    const reason: HarnessFailureReason =
      classifyFailure(text, exitCode === 0 ? 1 : exitCode) === 'rate_limit' ? 'rate_limit' : 'usage_cap';
    return { kind: reason, ...(resetAt ? { resetAt } : {}), reason, detail };
  }
  let reason: HarnessFailureReason;
  if (opts.zeroTokenResult) {
    reason = 'unavailable';
  } else {
    reason = classifyFailure(text, exitCode === 0 ? 1 : exitCode);
    if (reason === 'unknown' && exitCode === 0) reason = 'error';
  }
  return { kind: failureKindFor(reason, text), reason, detail };
}
