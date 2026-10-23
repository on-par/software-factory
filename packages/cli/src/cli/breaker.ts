// packages/cli/src/cli/breaker.ts — `factory breaker reset <provider>` (#3232)

import type { EventKind, ProviderBreaker } from '@on-par/factory-core';

import { CliExitError } from './index.js';

export interface BreakerResetDeps {
  breaker: ProviderBreaker;
  log: (
    type: EventKind,
    msg: string,
    extra?: { providerBreakerClose: { provider: string; cause: 'manual_reset' } },
  ) => void;
  out?: (line: string) => void;
}

/** Closes the provider's breaker now. Exits 1, listing the open providers, when it has no entry. */
export async function runBreakerReset(provider: string, deps: BreakerResetDeps): Promise<void> {
  const { breaker, log, out = console.log } = deps;
  const entry = await breaker.reset(provider);
  if (!entry) {
    const names = (await breaker.list()).map((b) => b.provider);
    throw new CliExitError(
      `factory breaker reset: ${provider} has no open breaker; open: ${names.join(', ') || '(none)'}`,
      1,
    );
  }
  log('provider_breaker_close', `breaker closed for ${provider} (manual_reset)`, {
    providerBreakerClose: { provider, cause: 'manual_reset' },
  });
  out(`reset the ${provider} breaker (${entry.reason})`);
}
