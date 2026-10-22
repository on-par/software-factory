// src/router/breaker.ts — Supervisor provider circuit breaker: file-backed
// cooldown state so a quota-tripped provider is skipped by subsequent lanes
// until the cooldown expires (#369).

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { EventKind } from '../events/kinds.js';
import type { FailoverReason } from '../types/index.js';

export interface BreakerEntry {
  reason: FailoverReason;
  openedAt: string;
  cooldownMs: number;
  /** ISO instant a usage cap holds the provider until; set only for usage caps (#3337). */
  cappedUntil?: string;
  /** True when the cap reported no reset, so the provider is re-probed at cappedUntil (#3337). */
  probeDue?: boolean;
}

export type BreakerStatus =
  { open: true; entry: BreakerEntry; remainingMs: number } | { open: false; justClosed?: BreakerEntry };

interface BreakerFile {
  version: 1;
  providers: Record<string, BreakerEntry>;
}

const RESET_HINT_PATTERN = /resets?\s+in\s+(?:(\d+)\s*hr)?\s*(?:(\d+)\s*min)?/i;

const ABSOLUTE_RESET_PATTERN =
  /resets?\s+at\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2}))/i;

/** Longest cooldown the breaker accepts from a provider-reported reset hint (31 days),
 *  so a typo'd or hostile far-future date can't park a provider indefinitely. */
/** Padding added to a provider-reported reset time so the breaker doesn't reopen just before the real reset. */
export const RESET_BUFFER_MS = 2 * 60_000;

/** A usage cap with no reported reset is re-probed after 1 hour (#3337). */
export const DEFAULT_CAP_PROBE_MS = 60 * 60_000;

export const MAX_REPORTED_COOLDOWN_MS = 31 * 24 * 60 * 60_000;

/** Extracts a provider-reported reset time so the breaker can cool down for as
 *  long as the provider actually says, instead of the flat default cooldown
 *  meant for transient rate limits. Understands the relative form ("Resets in
 *  3hr 17min", opencode.ai's weekly-usage-cap error) and the absolute form
 *  ("resets at 2026-11-01T00:00:00Z", OpenCode Go's monthly cap), the latter
 *  measured against `now`. Returns null when the text has no parseable hint
 *  (relative hour and minute groups absent or zero; absolute instant
 *  unparseable, offset-less, or at or before `now`), so the caller falls back
 *  to its own default. `bufferMs` pads the parsed duration so the breaker
 *  doesn't reopen a few seconds before the real reset. Results are capped at
 *  MAX_REPORTED_COOLDOWN_MS. */
export function parseResetCooldownMs(
  text: string,
  bufferMs = RESET_BUFFER_MS,
  now: number = Date.now(),
): number | null {
  const match = RESET_HINT_PATTERN.exec(text);
  if (match) {
    const hours = match[1] ? Number(match[1]) : 0;
    const minutes = match[2] ? Number(match[2]) : 0;
    if (hours !== 0 || minutes !== 0) {
      return Math.min((hours * 60 + minutes) * 60_000 + bufferMs, MAX_REPORTED_COOLDOWN_MS);
    }
  }
  const absolute = ABSOLUTE_RESET_PATTERN.exec(text);
  if (!absolute) return null;
  const resetAt = Date.parse(absolute[1]);
  if (Number.isNaN(resetAt) || resetAt <= now) return null;
  return Math.min(resetAt - now + bufferMs, MAX_REPORTED_COOLDOWN_MS);
}

/** Cooldown for a provider failure: the structured `resetAt` (ISO instant, plus the buffer) when it is a valid future
 *  time, else the text hint in `detail`, else null so the caller uses its default (#3225). */
export function reportedCooldownMs(
  resetAt: string | undefined,
  detail: string | undefined,
  now = Date.now(),
): number | null {
  const resetMs = resetAt ? Date.parse(resetAt) : Number.NaN;
  if (Number.isFinite(resetMs) && resetMs > now)
    return Math.min(resetMs - now + RESET_BUFFER_MS, MAX_REPORTED_COOLDOWN_MS);
  return parseResetCooldownMs(detail ?? '', RESET_BUFFER_MS, now);
}

export class ProviderBreaker {
  constructor(
    private file: string,
    private now: () => number = () => Date.now(),
  ) {}

  /** Upsert (refresh openedAt on repeat trips). Atomic write: mkdir parent, write `${file}.tmp`, rename.
   *  Reports whether the provider was already open, so callers can emit once-per-transition events. */
  async open(
    provider: string,
    reason: FailoverReason,
    cooldownMs: number,
    cap?: { cappedUntil: string; probeDue?: boolean },
  ): Promise<{ wasOpen: boolean }> {
    const data = await this.read();
    const now = this.now();
    const existing = data.providers[provider];
    const wasOpen = existing !== undefined && new Date(existing.openedAt).getTime() + existing.cooldownMs - now > 0;
    data.providers[provider] = {
      reason,
      openedAt: new Date(now).toISOString(),
      cooldownMs,
      ...(cap ? { cappedUntil: cap.cappedUntil, ...(cap.probeDue ? { probeDue: true } : {}) } : {}),
    };
    await this.write(data);
    return { wasOpen };
  }

  /** Reads the file. If the entry's openedAt + cooldownMs <= now(), prune it
   *  (rewrite the file without it) and return { open: false, justClosed: entry }
   *  so the caller can emit provider_breaker_close exactly once per observer.
   *  Missing/corrupt/unparsable file => { open: false }. */
  async status(provider: string): Promise<BreakerStatus> {
    const data = await this.read();
    const entry = data.providers[provider];
    if (!entry) return { open: false };

    const remainingMs = new Date(entry.openedAt).getTime() + entry.cooldownMs - this.now();
    if (remainingMs > 0) return { open: true, entry, remainingMs };

    delete data.providers[provider];
    await this.write(data);
    return { open: false, justClosed: entry };
  }

  /** Read-only (never rewrites the file — factory status must not mutate state).
   *  Returns only still-open entries with computed remainingMs. */
  async list(): Promise<Array<{ provider: string; reason: FailoverReason; openedAt: string; remainingMs: number }>> {
    const data = await this.read();
    const out: Array<{ provider: string; reason: FailoverReason; openedAt: string; remainingMs: number }> = [];
    for (const [provider, entry] of Object.entries(data.providers)) {
      const remainingMs = new Date(entry.openedAt).getTime() + entry.cooldownMs - this.now();
      if (remainingMs > 0) {
        out.push({ provider, reason: entry.reason, openedAt: entry.openedAt, remainingMs });
      }
    }
    return out;
  }

  private async read(): Promise<BreakerFile> {
    try {
      const raw = await readFile(this.file, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<BreakerFile>;
      return { version: 1, providers: parsed.providers ?? {} };
    } catch {
      return { version: 1, providers: {} };
    }
  }

  private async write(data: BreakerFile): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`);
    // Two lanes racing on expiry may both prune-and-rewrite (or both open) —
    // benign, at most a duplicate provider_breaker_close/open event; no lock file.
    await rename(tmp, this.file);
  }
}

/** Pre-BUILD gate used by the CLI lane runner. For each provider:
 *  - open  => log('provider_breaker_skip', ...) and return codexBlocked: true
 *  - justClosed => log('provider_breaker_close', ...)
 *  Round minutes with Math.ceil(remainingMs / 60000). */
export async function gateBuildOnBreaker(opts: {
  breaker: ProviderBreaker;
  providers: string[];
  log: (type: EventKind, msg: string) => void;
}): Promise<{ codexBlocked: boolean }> {
  const { breaker, providers, log } = opts;
  let codexBlocked = false;

  for (const provider of providers) {
    const status = await breaker.status(provider);
    if (status.open) {
      codexBlocked = true;
      const m = Math.ceil(status.remainingMs / 60_000);
      log(
        'provider_breaker_skip',
        `breaker open for ${provider} (${status.entry.reason}) — routing build to claude fallback, ${m}m remaining`,
      );
    } else if (status.justClosed) {
      log('provider_breaker_close', `breaker closed for ${provider} after cooldown — codex workers eligible again`);
    }
  }

  return { codexBlocked };
}
