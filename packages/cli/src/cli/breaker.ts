// packages/cli/src/cli/breaker.ts — `factory breaker reset <provider>` (#3232)

import { getFactoryPaths, ProviderBreaker } from '@on-par/factory-core';
import { logEvent } from '@on-par/factory-core/internal';

import { CliExitError } from './index.js';

export interface BreakerResetDeps {
  breakerFile?: string;
  eventsFile?: string;
  /** Resolves the repo root when the file paths are not injected. */
  getRepoRoot?: () => Promise<string>;
  out?: (line: string) => void;
}

/** Closes a provider's breaker now, e.g. after its credentials were fixed. Exits 1 listing the open breakers
 *  when the provider has none. */
export async function cmdBreakerReset(provider: string, deps: BreakerResetDeps = {}): Promise<void> {
  const out = deps.out ?? console.log;
  let { breakerFile, eventsFile } = deps;
  if (breakerFile === undefined || eventsFile === undefined) {
    if (!deps.getRepoRoot) throw new CliExitError('factory breaker reset: cannot resolve the repo root', 2);
    const paths = getFactoryPaths(await deps.getRepoRoot());
    breakerFile ??= paths.breaker;
    eventsFile ??= paths.events;
  }
  const breaker = new ProviderBreaker(breakerFile);
  const removed = await breaker.reset(provider);
  if (!removed) {
    const open = await breaker.list();
    throw new CliExitError(
      `No open breaker for ${provider}. Open breakers: ${open.map((b) => b.provider).join(', ') || 'none'}`,
      1,
    );
  }
  logEvent(eventsFile, 'provider_breaker_close', '-', `breaker reset for ${provider} (manual_reset)`, {
    providerBreakerClose: { provider, cause: 'manual_reset' },
  });
  out(`Breaker for ${provider} reset.`);
}
