// src/run/provider-failure-recorder.ts — Opens the provider breaker on a provider failure and announces a usage cap once (#3337).

import type { ProviderCappedPayload } from '../events/kinds.js';
import { DEFAULT_CAP_PROBE_MS, reportedCooldownMs, type ProviderBreaker } from '../router/breaker.js';
import { redactSecrets } from '../router/failure-detail.js';
import type { ProviderFailureInfo } from '../router/index.js';
import type { RunLogFn } from './attribution.js';

export interface ProviderFailureRecorderDeps {
  breaker: ProviderBreaker;
  log: RunLogFn;
  issue: number;
  /** Cooldown for failures that are not usage caps and report no reset time. */
  defaultCooldownMs: number;
}

/** Builds the per-stage `onProviderFailure` callback. A usage cap is held until its reported reset (plus the buffer),
 *  or re-probed after DEFAULT_CAP_PROBE_MS when none is reported; other kinds keep the default cooldown.
 *  `provider_capped` is logged only on the closed-to-open transition. */
export const providerFailureRecorder =
  (deps: ProviderFailureRecorderDeps) =>
  (stage: ProviderCappedPayload['stage']) =>
  async ({ provider, reason, kind, resetAt, detail }: ProviderFailureInfo): Promise<void> => {
    const { breaker, log, issue, defaultCooldownMs } = deps;
    const now = Date.now();
    const reportedMs = reportedCooldownMs(resetAt, detail, now);
    const capped = (kind ?? (reason === 'usage_cap' ? 'usage_cap' : undefined)) === 'usage_cap';
    const cooldownMs = reportedMs ?? (capped ? DEFAULT_CAP_PROBE_MS : defaultCooldownMs);
    const cappedUntil = capped ? new Date(now + cooldownMs).toISOString() : undefined;
    const { wasOpen } = await breaker.open(
      provider,
      reason,
      cooldownMs,
      cappedUntil ? { cappedUntil, probeDue: reportedMs === null } : undefined,
    );
    // prettier-ignore
    const cooldownNote = reportedMs !== null ? 'provider-reported reset time' : capped ? 'usage cap with no reported reset, re-probe after 1h' : 'default cooldown';
    log(
      'provider_breaker_open',
      `breaker opened for ${provider} (${reason}) — provider skipped until cooldown ends (${cooldownNote}, ${Math.ceil(cooldownMs / 60_000)}m)`,
      { failoverReason: reason, ...(kind ? { providerFailureKind: kind } : {}) },
    );
    if (cappedUntil && !wasOpen) {
      const source = reportedMs !== null ? 'reported' : 'default-1h';
      log('provider_capped', `${provider} capped until ${cappedUntil} (${source}) during ${stage} — failing over`, {
        failoverReason: reason,
        providerCapped: { provider, stage, issue, cappedUntil, source, detail: redactSecrets(detail ?? '') },
      });
    }
  };
