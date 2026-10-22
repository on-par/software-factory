import { pickOpencodeFallback } from '../phases/build-opencode-failover.js';
import { describeBreakerRemaining, type ProviderBreaker } from '../router/breaker.js';
import type { ModelRouter } from '../router/index.js';
import type { EventKind } from '../events/kinds.js';
import type { FailoverReason } from '../types/index.js';

type GateLog = (type: EventKind, msg: string, extra?: { failoverReason?: FailoverReason }) => void;

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
  deps.log(
    'provider_breaker_skip',
    `breaker open for ${provider} (${status.entry.reason}) — using ${fallback} for ${phase}, ${describeBreakerRemaining(status.remainingMs)}`,
  );
  return fallback;
}

export const providerFallbackPreferrer =
  (deps: GateDeps) =>
  (primary: string | undefined, fallback: string | undefined, phase: string): Promise<string | undefined> =>
    preferFallbackWhenProviderIsOpen(deps, primary, fallback, phase);

export type OpencodeBreakerGate =
  | {
      kind: 'swap';
      route: 'claude' | 'codex';
      task: 'build_claude' | 'build_codex';
      model: string;
      reason: FailoverReason;
    }
  | { kind: 'blocked'; reason: FailoverReason; resetAt?: string; message: string };

/**
 * Pre-BUILD breaker gate for the opencode route (#2891, #3035). Unpinned: returns a swap to the first
 * build_claude (else build_codex) worker, with the breaker reason (also logged as worker_failover), when the opencode model's provider breaker
 * is open. Pinned by the repo (ADR-0092): never swaps; returns a blocked result carrying the cap reason and
 * reset time so BUILD fails fast instead of starting on a capped provider.
 */
export async function gateOpencodeBuildOnBreaker(
  deps: GateDeps,
  opts: { opencodeModel: string | undefined; routePinned: boolean; codexDisabled: boolean; now?: number },
): Promise<OpencodeBreakerGate | undefined> {
  const { router, breaker, log } = deps;
  const { opencodeModel } = opts;
  const provider = opencodeModel ? router.registryRef.get(opencodeModel)?.provider : undefined;
  if (!provider) return undefined;
  if (opts.routePinned) {
    const status = await breaker.status(provider);
    if (!status.open) return undefined;
    const reason = status.entry.reason;
    log(
      'provider_breaker_pinned',
      `breaker open for ${provider} (${reason}) — keeping the opencode route pinned by .factory/config.json, ${describeBreakerRemaining(status.remainingMs)}`,
    );
    const pinned = 'not failing over: build route pinned to opencode in .factory/config.json (ADR-0092)';
    if (!Number.isFinite(status.remainingMs)) {
      return {
        kind: 'blocked',
        reason,
        message: `OpenCode build workers blocked (${reason}); ${pinned}; blocked until its credentials change (or \`factory breaker reset\`)`,
      };
    }
    const resetAt = new Date((opts.now ?? Date.now()) + status.remainingMs).toISOString();
    return {
      kind: 'blocked',
      reason,
      resetAt,
      message: `OpenCode build workers capped (${reason}); ${pinned}; resets at ${resetAt}`,
    };
  }
  const target = pickOpencodeFallback(router, opts.codexDisabled);
  if (!target || target.model === opencodeModel) return undefined;
  const status = await breaker.status(provider);
  if (!status.open) return undefined;
  log(
    'provider_breaker_skip',
    `breaker open for ${provider} (${status.entry.reason}) — using ${target.model} for BUILD, ${describeBreakerRemaining(status.remainingMs)}`,
  );
  log(
    'worker_failover',
    `OpenCode provider breaker open (${status.entry.reason}) — starting BUILD on ${target.route}: from_model=${opencodeModel} to_model=${target.model} from_route=build_opencode to_route=${target.task} reason=${status.entry.reason}`,
    { failoverReason: status.entry.reason },
  );
  return { kind: 'swap', route: target.route, task: target.task, model: target.model, reason: status.entry.reason };
}
