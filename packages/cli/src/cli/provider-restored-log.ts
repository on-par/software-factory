// packages/cli/src/cli/provider-restored-log.ts — a ProviderBreaker whose closes write provider_restored (#3236)

import { ProviderBreaker } from '@on-par/factory-core';
import { logEvent as defaultLogEvent } from '@on-par/factory-core/internal';

/** Builds a breaker whose every close (any observer, any cause) records one `provider_restored` event. */
export function restoredLoggingBreaker(
  breakerFile: string,
  eventsFile: string,
  issue: number | string,
  lane?: string,
  logEvent: typeof defaultLogEvent = defaultLogEvent,
): ProviderBreaker {
  return new ProviderBreaker(breakerFile, undefined, {
    onClose: (r) =>
      logEvent(eventsFile, 'provider_restored', issue, `provider ${r.provider} restored (${r.cause})`, {
        lane,
        providerRestored: r,
      }),
  });
}
