// src/router/breaker.ts — Supervisor provider circuit breaker: file-backed
// cooldown state so a quota-tripped provider is skipped by subsequent lanes
// until the cooldown expires (#369).

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { EventKind } from '../events/kinds.js';
import type { ProviderBreakerClosePayload, ProviderRestoredPayload } from '../events/payloads.js';
import type { FailoverReason } from '../types/index.js';
import { credentialFingerprint } from './credential-fingerprint.js';

export interface BreakerEntry {
  reason: FailoverReason;
  openedAt: string;
  cooldownMs: number;
  /** ISO instant a usage cap holds the provider until; set only for usage caps (#3337). */
  cappedUntil?: string;
  /** True when the cap reported no reset, so the provider is re-probed at cappedUntil (#3337). */
  probeDue?: boolean;
  /** Untimed hold: a rejected credential keeps the provider out until its credentials change (#3232). */
  until?: 'credentials-change';
  /** sha256 fingerprint of the provider's credential sources when the entry opened; no key material. */
  credentialFingerprint?: string;
}

export type BreakerStatus =
  | { open: true; entry: BreakerEntry; remainingMs: number }
  | { open: false; justClosed?: BreakerEntry; closeCause?: 'cooldown' | 'creds_changed' };

export interface BreakerListEntry {
  provider: string;
  reason: FailoverReason;
  openedAt: string;
  remainingMs: number;
  until?: 'credentials-change';
}

/** "12m remaining", or "until credentials change" for an untimed entry (remainingMs is Infinity). */
export function formatBreakerRemaining(remainingMs: number): string {
  return Number.isFinite(remainingMs) ? `${Math.ceil(remainingMs / 60_000)}m remaining` : 'until credentials change';
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

/** A usage cap with no reported reset is re-probed after 1 hour (#3337). */
export const DEFAULT_CAP_PROBE_MS = 60 * 60_000;

/** A restore-probe claim older than this (twice the 60s probe timeout) is from a dead lane and can be reclaimed (#3339). */
export const PROBE_CLAIM_STALE_MS = 2 * 60_000;

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

/** Maps a breaker close cause to the `provider_restored` cause (#3236). */
export function restoredCause(
  cause: 'cooldown' | 'creds_changed' | 'manual_reset' | 'probe',
): ProviderRestoredPayload['cause'] {
  return cause === 'cooldown' ? 'timed_reset' : cause;
}

export class ProviderBreaker {
  constructor(
    private file: string,
    private now: () => number = () => Date.now(),
    opts: { fingerprint?: (provider: string) => string; onClose?: (restored: ProviderRestoredPayload) => void } = {},
  ) {
    this.onClose = opts.onClose;
    const fingerprint = opts.fingerprint ?? ((p: string) => credentialFingerprint(p));
    this.fingerprint = (p) => {
      try {
        return fingerprint(p);
      } catch {
        return '<error>';
      }
    };
  }

  private fingerprint: (provider: string) => string;
  private onClose: ((restored: ProviderRestoredPayload) => void) | undefined;

  /** Tells `onClose` the breaker closed (#3236). A throwing observer never changes breaker gating. */
  private notifyClose(provider: string, cause: 'cooldown' | 'creds_changed' | 'manual_reset' | 'probe'): void {
    try {
      this.onClose?.({ provider, at: new Date(this.now()).toISOString(), cause: restoredCause(cause) });
    } catch {
      // logging must never change gating
    }
  }

  private isOpen(provider: string, entry: BreakerEntry, now: number): boolean {
    if (entry.until === 'credentials-change')
      return entry.credentialFingerprint !== undefined && entry.credentialFingerprint === this.fingerprint(provider);
    return new Date(entry.openedAt).getTime() + entry.cooldownMs - now > 0;
  }

  /** Opens an untimed entry held until the provider's credentials change or `reset()` (#3232). `wasOpen` is true only
   *  while the existing entry (timed or untimed) is still open, so a provider already held for a cap logs no duplicate. */
  async openUntilCredentialsChange(provider: string, reason: FailoverReason): Promise<{ wasOpen: boolean }> {
    const data = await this.read();
    const now = this.now();
    const existing = data.providers[provider];
    const wasOpen = existing !== undefined && this.isOpen(provider, existing, now);
    data.providers[provider] = {
      reason,
      openedAt: new Date(now).toISOString(),
      cooldownMs: 0,
      until: 'credentials-change',
      credentialFingerprint: this.fingerprint(provider),
    };
    await this.write(data);
    return { wasOpen };
  }

  /** Removes the provider's entry (open or not). Returns the removed entry, or undefined when there was none. */
  async reset(provider: string): Promise<BreakerEntry | undefined> {
    const data = await this.read();
    const entry = data.providers[provider];
    if (!entry) return undefined;
    delete data.providers[provider];
    await this.write(data);
    this.notifyClose(provider, 'manual_reset');
    return entry;
  }

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
    const wasOpen = existing !== undefined && this.isOpen(provider, existing, now);
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
   *  The pruning observer also calls `onClose` (provider_restored, #3236).
   *  Missing/corrupt/unparsable file => { open: false }. */
  async status(provider: string): Promise<BreakerStatus> {
    const data = await this.read();
    const entry = data.providers[provider];
    if (!entry) return { open: false };

    if (entry.until === 'credentials-change') {
      if (this.isOpen(provider, entry, this.now())) return { open: true, entry, remainingMs: Number.POSITIVE_INFINITY };
      delete data.providers[provider];
      await this.write(data);
      this.notifyClose(provider, 'creds_changed');
      return { open: false, justClosed: entry, closeCause: 'creds_changed' };
    }

    const remainingMs = new Date(entry.openedAt).getTime() + entry.cooldownMs - this.now();
    if (remainingMs > 0) return { open: true, entry, remainingMs };
    // another lane is probing this past-due cap: stay open so no reader time-closes it meanwhile (#3339)
    if (this.dueCap(entry) !== undefined && (await this.freshClaim(provider, entry))) {
      return { open: true, entry, remainingMs: 0 };
    }

    delete data.providers[provider];
    await this.write(data);
    this.notifyClose(provider, 'cooldown');
    return { open: false, justClosed: entry, closeCause: 'cooldown' };
  }

  private claimPath(provider: string, cappedUntilMs: number): string {
    return `${this.file}.probe-${provider}-${cappedUntilMs}`;
  }

  /** The cap's instant when the entry is a timed usage cap whose `cappedUntil` has passed, else undefined (#3339). */
  private dueCap(entry: BreakerEntry): number | undefined {
    if (!entry.cappedUntil || entry.until === 'credentials-change') return undefined;
    const at = Date.parse(entry.cappedUntil);
    return Number.isFinite(at) && at <= this.now() ? at : undefined;
  }

  private async freshClaim(provider: string, entry: BreakerEntry): Promise<boolean> {
    const at = this.dueCap(entry);
    if (at === undefined) return false;
    try {
      const claimedAt = Number(await readFile(this.claimPath(provider, at), 'utf-8'));
      return Number.isFinite(claimedAt) && this.now() - claimedAt <= PROBE_CLAIM_STALE_MS;
    } catch {
      return false;
    }
  }

  private async removeClaim(provider: string, entry: BreakerEntry | undefined): Promise<void> {
    const at = entry?.cappedUntil ? Date.parse(entry.cappedUntil) : Number.NaN;
    if (!Number.isFinite(at)) return;
    await unlink(this.claimPath(provider, at)).catch(() => undefined);
  }

  /** Read-only: the entry when it is a usage cap whose `cappedUntil` has passed and is due a restore probe (#3339). */
  async probeDue(provider: string): Promise<BreakerEntry | undefined> {
    const entry = (await this.read()).providers[provider];
    return entry && this.dueCap(entry) !== undefined ? entry : undefined;
  }

  /** Takes the one cross-lane probe claim for the provider's current cap: an exclusive-create claim file next to the
   *  breaker file. A claim older than PROBE_CLAIM_STALE_MS (a dead lane) is reclaimed (#3339). */
  async claimProbe(provider: string): Promise<'claimed' | 'taken' | 'not-due'> {
    const entry = (await this.read()).providers[provider];
    const at = entry ? this.dueCap(entry) : undefined;
    if (at === undefined) return 'not-due';
    const path = this.claimPath(provider, at);
    const tryClaim = async (): Promise<'claimed' | 'exists'> => {
      try {
        await mkdir(dirname(this.file), { recursive: true });
        await writeFile(path, String(this.now()), { flag: 'wx' });
        return 'claimed';
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') return 'exists';
        throw err;
      }
    };
    try {
      if ((await tryClaim()) === 'claimed') return 'claimed';
      const claimedAt = Number(await readFile(path, 'utf-8'));
      if (Number.isFinite(claimedAt) && this.now() - claimedAt <= PROBE_CLAIM_STALE_MS) return 'taken';
      await unlink(path);
      return (await tryClaim()) === 'claimed' ? 'claimed' : 'taken';
    } catch {
      return 'taken'; // fail safe: neither probe nor time-close
    }
  }

  /** A passed probe: prunes the entry, drops the claim and reports `provider_restored` with cause `probe` (#3339). */
  async closeAfterProbe(provider: string): Promise<void> {
    const data = await this.read();
    const entry = data.providers[provider];
    if (entry) {
      delete data.providers[provider];
      await this.write(data);
    }
    await this.removeClaim(provider, entry);
    this.notifyClose(provider, 'probe');
  }

  /** A failed probe: re-opens the cap from the error's reported reset (else DEFAULT_CAP_PROBE_MS) without a
   *  `provider_capped` event, which only providerFailureRecorder emits (#3339). */
  async recapAfterProbe(
    provider: string,
    opts: { reason?: FailoverReason; detail?: string } = {},
  ): Promise<{ cappedUntil: string }> {
    const now = this.now();
    const existing = (await this.read()).providers[provider];
    const reportedMs = reportedCooldownMs(undefined, opts.detail, now);
    const cooldownMs = reportedMs ?? DEFAULT_CAP_PROBE_MS;
    const cappedUntil = new Date(now + cooldownMs).toISOString();
    await this.open(provider, opts.reason ?? existing?.reason ?? 'usage_cap', cooldownMs, {
      cappedUntil,
      probeDue: reportedMs === null,
    });
    await this.removeClaim(provider, existing);
    return { cappedUntil };
  }

  /** Read-only (never prunes, so the close event stays for `status()` observers): true while the provider is held
   *  until its credentials change and the credentials have not changed. */
  async isHeldUntilCredentialsChange(provider: string): Promise<boolean> {
    const entry = (await this.read()).providers[provider];
    return entry?.until === 'credentials-change' && this.isOpen(provider, entry, this.now());
  }

  /** Read-only (never rewrites the file — factory status must not mutate state).
   *  Returns only still-open entries with computed remainingMs. */
  async list(): Promise<BreakerListEntry[]> {
    const data = await this.read();
    const out: BreakerListEntry[] = [];
    for (const [provider, entry] of Object.entries(data.providers)) {
      if (entry.until === 'credentials-change') {
        if (this.isOpen(provider, entry, this.now())) {
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
  log: (type: EventKind, msg: string, extra?: { providerBreakerClose?: ProviderBreakerClosePayload }) => void;
}): Promise<{ codexBlocked: boolean }> {
  const { breaker, providers, log } = opts;
  let codexBlocked = false;

  for (const provider of providers) {
    const status = await breaker.status(provider);
    if (status.open) {
      codexBlocked = true;
      log(
        'provider_breaker_skip',
        `breaker open for ${provider} (${status.entry.reason}) — routing build to claude fallback, ${formatBreakerRemaining(status.remainingMs)}`,
      );
    } else if (status.justClosed) {
      const cause = status.closeCause ?? 'cooldown';
      log('provider_breaker_close', `breaker closed for ${provider} (${cause}) — codex workers eligible again`, {
        providerBreakerClose: { provider, cause },
      });
    }
  }

  return { codexBlocked };
}
