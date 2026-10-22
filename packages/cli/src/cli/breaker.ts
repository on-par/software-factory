// packages/cli/src/cli/breaker.ts — `factory breaker reset <provider>`: close an open provider breaker by hand (#3232).

import { createLogger, ProviderBreaker, type BreakerEntry } from '@on-par/factory-core';

export type BreakerResetResult =
  { ok: true; provider: string; entry: BreakerEntry } | { ok: false; provider: string; open: string[] };

/** Removes the provider's open breaker entry and logs provider_breaker_close with cause manual_reset.
 *  Without an open entry it changes nothing and reports which providers are open. */
export async function runBreakerReset(opts: {
  breakerFile: string;
  eventsFile: string;
  provider: string;
}): Promise<BreakerResetResult> {
  const { breakerFile, eventsFile, provider } = opts;
  const breaker = new ProviderBreaker(breakerFile);
  const status = await breaker.status(provider);
  if (!status.open) return { ok: false, provider, open: (await breaker.list()).map((b) => b.provider) };
  const entry = (await breaker.reset(provider)) ?? status.entry;
  createLogger(eventsFile, {}, { out: { write: () => true } }).info(
    'provider_breaker_close',
    `breaker closed for ${provider} (cause=manual_reset) — reset by operator`,
    { breakerClose: { provider, cause: 'manual_reset' } },
  );
  return { ok: true, provider, entry };
}
