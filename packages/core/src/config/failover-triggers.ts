// src/config/failover-triggers.ts — failover.triggers are provider failure kinds, not reasons

import { z } from 'zod';
import type { ProviderFailureKind } from '../harness/provider-failure.js'; // type-only: no runtime cycle

export const FAILOVER_TRIGGER_KINDS = [
  'rate_limit',
  'auth',
  'unavailable',
  'usage_cap',
] as const satisfies readonly ProviderFailureKind[];

export const DEFAULT_FAILOVER_TRIGGERS = [
  'rate_limit',
  'unavailable',
  'auth',
] as const satisfies readonly ProviderFailureKind[];

/** Legacy failure-reason names mapped to their kind; only used to make error messages helpful. */
const LEGACY_REASON_KIND: Record<string, string> = {
  timeout: 'unavailable',
  error: 'unavailable',
  empty_response: 'unavailable',
  cli_missing: 'unavailable',
  unknown: 'unavailable',
  local_auth: 'unavailable',
};

export const FailoverTriggersSchema = z.array(z.string()).superRefine((entries, ctx) => {
  entries.forEach((entry, i) => {
    if ((FAILOVER_TRIGGER_KINDS as readonly string[]).includes(entry)) return;
    let message: string;
    if (entry === 'other') {
      message = "'other' is a deterministic failure kind and never fails over; remove it";
    } else if (Object.hasOwn(LEGACY_REASON_KIND, entry)) {
      message = `'${entry}' is a failure reason, not a kind; use '${LEGACY_REASON_KIND[entry]}'`;
    } else {
      message = `'${entry}' is not a failure kind; use rate_limit, unavailable or auth`;
    }
    ctx.addIssue({ code: 'custom', path: [i], message });
  });
});

/** Non-fatal findings in a raw `failover` section: a no-op `usage_cap` trigger and the removed escalateAfterTierExhausted key. */
export function failoverConfigWarnings(failover: unknown, path: string): string[] {
  if (typeof failover !== 'object' || failover === null || Array.isArray(failover)) return [];
  const warnings: string[] = [];
  const triggers = (failover as { triggers?: unknown }).triggers;
  if (Array.isArray(triggers) && triggers.includes('usage_cap')) {
    warnings.push(
      `${path}.triggers: 'usage_cap' has no effect: a usage cap always ends the call, and the phase reruns on the next provider at the phase boundary`,
    );
  }
  if ('escalateAfterTierExhausted' in failover) {
    warnings.push(`${path}.escalateAfterTierExhausted is deprecated and ignored; remove it`);
  }
  return warnings;
}
