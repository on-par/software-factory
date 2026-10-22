// src/router/breaker.ts — Supervisor provider circuit breaker: file-backed
// cooldown state so a quota-tripped provider is skipped by subsequent lanes
// until the cooldown expires (#369).

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { EventKind } from '../events/kinds.js';
import type { FailoverReason } from '../types/index.js';
import { credentialFingerprint } from './credential-fingerprint.js';

/** Opens for a fixed cooldown. Old breaker files hold only these. */
export interface TimedBreakerEntry {
  reason: FailoverReason;
  openedAt: string;
  cooldownMs: number;
}

/** Opens until the provider's credentials change (kind `auth`, #3232). Holds only the sha256 fingerprint. */
export interface CredentialsBreakerEntry {
  reason: FailoverReason;
  openedAt: string;
  until: 'credentials-change';
  credentialFingerprint: string;
}

export type BreakerEntry = TimedBreakerEntry | CredentialsBreakerEntry;

export function isCredentialsEntry(entry: BreakerEntry): entry is CredentialsBreakerEntry {
  return 'until' in entry && entry.until === 'credentials-change';
}

export interface BreakerCloseEvent {
  provider: string;
  entry: BreakerEntry;
  cause: 'creds_changed' | 'manual_reset';
}

export interface ProviderBreakerOptions {
  fingerprint?: (provider: string) => Promise<string>;
  onClose?: (event: BreakerCloseEvent) => void;
}

export type BreakerStatus =
  { open: true; entry: BreakerEntry; remainingMs: number } | { open: false; justClosed?: BreakerEntry };

export interface BreakerListing {
  provider: string;
  reason: FailoverReason;
  openedAt: string;
  remainingMs: number;
  until?: 'credentials-change';
}

/** "12m remaining" for a timed entry; the credentials wording when remainingMs is not finite (untimed entry). */
export function describeBreakerRemaining(remainingMs: number): string {
  return Number.isFinite(remainingMs)
    ? `${Math.ceil(remainingMs / 60_000)}m remaining`
    : 'until credentials change (or `factory breaker reset`)';
}

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

function remainingOf(entry: TimedBreakerEntry, now: number): number {
  return new Date(entry.openedAt).getTime() + entry.cooldownMs - now;
}

export class ProviderBreaker {
  private fingerprint: (provider: string) => Promise<string>;
  private onClose?: (event: BreakerCloseEvent) => void;

  constructor(
    private file: string,
    private now: () => number = () => Date.now(),
    opts: ProviderBreakerOptions = {},
  ) {
    this.fingerprint = opts.fingerprint ?? ((provider) => credentialFingerprint(provider));
    this.onClose = opts.onClose;
  }

  /** Upsert (refresh openedAt on repeat trips). Atomic write: mkdir parent, write `${file}.tmp`, rename. */
  async open(provider: string, reason: FailoverReason, cooldownMs: number): Promise<void> {
    const data = await this.read();
    data.providers[provider] = { reason, openedAt: new Date(this.now()).toISOString(), cooldownMs };
    await this.write(data);
  }

  /** Opens an untimed entry keyed on the provider's credential fingerprint (#3232). Returns true only on a
   *  transition into the auth-open state (a timed or absent entry is replaced); false when already auth-open. */
  async openUntilCredentialsChange(provider: string, reason: FailoverReason): Promise<boolean> {
    const data = await this.read();
    const existing = data.providers[provider];
    if (existing && isCredentialsEntry(existing)) return false;
    data.providers[provider] = {
      reason,
      openedAt: new Date(this.now()).toISOString(),
      until: 'credentials-change',
      credentialFingerprint: await this.fingerprint(provider),
    };
    await this.write(data);
    return true;
  }

  /** Reads the file. If the entry's openedAt + cooldownMs <= now(), prune it
   *  (rewrite the file without it) and return { open: false, justClosed: entry }
   *  so the caller can emit provider_breaker_close exactly once per observer.
   *  An untimed entry stays open (remainingMs Infinity) until its fingerprint changes: then it is pruned and
   *  onClose fires with cause creds_changed (no justClosed, so gateBuildOnBreaker does not log twice).
   *  Missing/corrupt/unparsable file => { open: false }. */
  async status(provider: string): Promise<BreakerStatus> {
    const data = await this.read();
    const entry = data.providers[provider];
    if (!entry) return { open: false };

    if (isCredentialsEntry(entry)) {
      const stored: unknown = entry.credentialFingerprint;
      if (typeof stored === 'string' && stored === (await this.fingerprint(provider))) {
        return { open: true, entry, remainingMs: Number.POSITIVE_INFINITY };
      }
      delete data.providers[provider];
      await this.write(data);
      try {
        this.onClose?.({ provider, entry, cause: 'creds_changed' });
      } catch {
        // Close logging must not break the gate.
      }
      return { open: false };
    }

    const remainingMs = remainingOf(entry, this.now());
    if (remainingMs > 0) return { open: true, entry, remainingMs };

    delete data.providers[provider];
    await this.write(data);
    return { open: false, justClosed: entry };
  }

  /** Removes the provider's entry (open or not) and returns it, else undefined. Does not call onClose: the
   *  caller (`factory breaker reset`) logs the manual_reset close itself. */
  async reset(provider: string): Promise<BreakerEntry | undefined> {
    const data = await this.read();
    const entry = data.providers[provider];
    if (!entry) return undefined;
    delete data.providers[provider];
    await this.write(data);
    return entry;
  }

  /** Read-only (never rewrites the file — factory status must not mutate state).
   *  Returns only still-open entries with computed remainingMs (Infinity + `until` for untimed entries whose
   *  fingerprint still matches). */
  async list(): Promise<BreakerListing[]> {
    const data = await this.read();
    const out: BreakerListing[] = [];
    for (const [provider, entry] of Object.entries(data.providers)) {
      if (isCredentialsEntry(entry)) {
        if (entry.credentialFingerprint === (await this.fingerprint(provider))) {
          out.push({
            provider,
            reason: entry.reason,
            openedAt: entry.openedAt,
            remainingMs: Number.POSITIVE_INFINITY,
            until: 'credentials-change',
          });
        }
        continue;
      }
      const remainingMs = remainingOf(entry, this.now());
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
      log(
        'provider_breaker_skip',
        `breaker open for ${provider} (${status.entry.reason}) — routing build to claude fallback, ${describeBreakerRemaining(status.remainingMs)}`,
      );
    } else if (status.justClosed) {
      log('provider_breaker_close', `breaker closed for ${provider} after cooldown — codex workers eligible again`);
    }
  }

  return { codexBlocked };
}
