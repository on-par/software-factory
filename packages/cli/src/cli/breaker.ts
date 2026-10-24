// packages/cli/src/cli/breaker.ts — `factory breaker reset <provider>` (#3232)

import { type EventKind, getFactoryPaths, ProviderBreaker } from '@on-par/factory-core';
import { logEvent } from '@on-par/factory-core/internal';

import { CliExitError, PROGRAM_HANDLERS } from './index.js';

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

export interface BreakerResetCommandDeps {
  getRepoRoot: () => Promise<string>;
  out?: (line: string) => void;
}

/** Resets the provider's breaker in the repo's factory state, logging to its events file. */
export async function runBreakerResetCommand(provider: string, deps: BreakerResetCommandDeps): Promise<void> {
  const paths = getFactoryPaths(await deps.getRepoRoot());
  await runBreakerReset(provider, {
    breaker: new ProviderBreaker(paths.breaker, undefined, {
      onClose: (r) =>
        logEvent(paths.events, 'provider_restored', '-', `provider ${r.provider} restored (${r.cause})`, {
          providerRestored: r,
        }),
    }),
    log: (type, msg, extra) => logEvent(paths.events, type, '-', msg, extra),
    out: deps.out,
  });
}

/** `factory breaker reset <provider>` (#3232): close a provider's breaker now. */
export async function cmdBreakerReset(provider: string): Promise<void> {
  await runBreakerResetCommand(provider, { getRepoRoot: () => PROGRAM_HANDLERS.getRepoRoot() });
}
