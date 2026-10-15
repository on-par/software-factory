import { pickOpencodeFallback } from '../phases/build-opencode-failover.js';
import type { ProviderBreaker } from '../router/breaker.js';
import type { ModelRouter } from '../router/index.js';
import type { EventKind } from '../events/kinds.js';

type GateLog = (type: EventKind, msg: string) => void;

type GateDeps = { router: ModelRouter; breaker: ProviderBreaker; log: GateLog };

/** The fallback model when the primary's provider breaker is open, else the primary (logs provider_breaker_skip). */
async function preferFallbackWhenProviderIsOpen(
  deps: GateDeps,
  primary: string | undefined,
  fallback: string | undefined,
  phase: string,
): Promise<string | undefined> {
  if (!primary || !fallback) return primary;
  const provider = deps.router.registryRef.get(primary)?.provider;
  if (!provider) return primary;
  const status = await deps.breaker.status(provider);
  if (!status.open) return primary;
  const minutes = Math.ceil(status.remainingMs / 60_000);
  deps.log(
    'provider_breaker_skip',
    `breaker open for ${provider} (${status.entry.reason}) — using ${fallback} for ${phase}, ${minutes}m remaining`,
  );
  return fallback;
}

export const providerFallbackPreferrer =
  (deps: GateDeps) =>
  (primary: string | undefined, fallback: string | undefined, phase: string): Promise<string | undefined> =>
    preferFallbackWhenProviderIsOpen(deps, primary, fallback, phase);

/**
 * Pre-BUILD breaker gate for the opencode route (#2891). Unpinned: returns the first build_claude (else
 * build_codex) worker when the opencode model's provider breaker is open. Pinned by the repo: keeps
 * opencode and only logs that the breaker is open.
 */
export async function gateOpencodeBuildOnBreaker(
  deps: GateDeps,
  opts: { opencodeModel: string | undefined; routePinned: boolean; codexDisabled: boolean },
): Promise<{ route: 'claude' | 'codex'; model: string } | undefined> {
  const { router, breaker, log } = deps;
  const { opencodeModel } = opts;
  if (opts.routePinned) {
    const provider = opencodeModel ? router.registryRef.get(opencodeModel)?.provider : undefined;
    const status = provider ? await breaker.status(provider) : undefined;
    if (provider && status?.open) {
      log(
        'provider_breaker_pinned',
        `breaker open for ${provider} (${status.entry.reason}) — keeping the opencode route pinned by .factory/config.json, ${Math.ceil(status.remainingMs / 60_000)}m remaining`,
      );
    }
    return undefined;
  }
  const target = pickOpencodeFallback(router, opts.codexDisabled);
  const selected = await preferFallbackWhenProviderIsOpen(deps, opencodeModel, target?.model, 'BUILD');
  return target && selected === target.model && selected !== opencodeModel ? target : undefined;
}
