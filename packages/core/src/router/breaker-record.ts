// src/router/breaker-record.ts — what a provider failure does to the provider breaker, and what it logs (#3232).

import type { BreakerClosePayload, EventKind, ProviderAuthRejectedPayload } from '../events/kinds.js';
import { redactText } from '../filing/redact.js';
import type { FailoverReason } from '../types/index.js';
import { reportedCooldownMs, type ProviderBreaker } from './breaker.js';
import type { ProviderFailureInfo } from './index.js';

export type RecordLogFn = (
  type: EventKind,
  msg: string,
  extra?: {
    failoverReason?: FailoverReason;
    providerFailureKind?: string;
    providerAuthRejected?: ProviderAuthRejectedPayload;
    breakerClose?: BreakerClosePayload;
  },
) => void;

export interface RecordProviderFailureDeps {
  breaker: ProviderBreaker;
  log: RecordLogFn;
  issue: number | string;
  defaultCooldownMs: number;
  now?: () => number;
}

/** Opens the provider breaker for a failure and logs it. Kind `auth` opens an untimed entry and writes one
 *  provider_auth_rejected per closed-to-open transition; every other kind opens a timed entry as before. */
export async function recordProviderFailure(deps: RecordProviderFailureDeps, info: ProviderFailureInfo): Promise<void> {
  const { breaker, log, issue, defaultCooldownMs } = deps;
  const { provider, reason, kind, resetAt, detail } = info;
  if (kind === 'auth') {
    if (!(await breaker.openUntilCredentialsChange(provider, reason))) return;
    log(
      'provider_breaker_open',
      `breaker opened for ${provider} (${reason}) — credential rejected; provider skipped until its credentials change or \`factory breaker reset ${provider}\``,
      { failoverReason: reason, providerFailureKind: kind },
    );
    const model = info.model ?? 'unknown';
    const harness = info.harness ?? 'unknown';
    const stage = info.task ?? 'unknown';
    log(
      'provider_auth_rejected',
      `${provider} rejected the credential (${model} via ${harness}, ${stage}) — fix the credential or run \`factory breaker reset ${provider}\``,
      {
        providerAuthRejected: {
          provider,
          harness,
          model,
          stage,
          issue: Number(issue) || issue,
          at: new Date((deps.now ?? Date.now)()).toISOString(),
          detail: redactText(detail ?? ''),
        },
      },
    );
    return;
  }
  const reportedMs = reportedCooldownMs(resetAt, detail);
  const cooldownMs = reportedMs ?? defaultCooldownMs;
  await breaker.open(provider, reason, cooldownMs);
  const cooldownNote = reportedMs !== null ? 'provider-reported reset time' : 'default cooldown';
  log(
    'provider_breaker_open',
    `breaker opened for ${provider} (${reason}) — provider skipped until cooldown ends (${cooldownNote}, ${Math.ceil(cooldownMs / 60_000)}m)`,
    { failoverReason: reason, ...(kind ? { providerFailureKind: kind } : {}) },
  );
}
