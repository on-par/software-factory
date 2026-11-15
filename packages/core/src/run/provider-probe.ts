import { subscriptionProviderOf, type ProviderOrder, type SubscriptionProviderId } from '../config/provider-order.js';
import type { EventKind } from '../events/kinds.js';
import type { ModelRegistry } from '../models/index.js';
import type { ProviderBreaker } from '../router/breaker.js';
import { routerFailureOf } from '../router/executor-error.js';
import type { ModelRouter } from '../router/index.js';
import { STAGE_ROLE, type FailoverStage } from './provider-breaker-gate.js';

export const PROBE_TIMEOUT_SECONDS = 60;
export const PROBE_PROMPT = 'Reply with the single word OK.';

export type ProviderProbe = (model: string) => Promise<void>;

export interface ProbeDeps {
  router: Pick<ModelRouter, 'registryRef'>;
  breaker: ProviderBreaker;
  probe: ProviderProbe;
  log?: (type: EventKind, msg: string) => void;
}

export function probeModelFor(
  order: ProviderOrder,
  provider: SubscriptionProviderId,
  registry: ModelRegistry,
  fallback: string,
): string {
  return order.triage.find((id) => subscriptionProviderOf(id, registry.get(id)) === provider) ?? fallback;
}

export function routerProviderProbe(router: Pick<ModelRouter, 'run'>): ProviderProbe {
  return async (model) => {
    await router.run('triage', PROBE_PROMPT, {
      modelOverride: model,
      modelFallbacks: [],
      timeoutSeconds: PROBE_TIMEOUT_SECONDS,
    });
  };
}

export function providerProbe(ports: { router: ModelRouter; probeProvider?: ProviderProbe }): ProviderProbe {
  return ports.probeProvider ?? routerProviderProbe(ports.router);
}

export async function probeIfDue(
  deps: ProbeDeps,
  order: ProviderOrder,
  provider: SubscriptionProviderId,
  breakerKey: string,
  stageModel: string,
): Promise<'restored' | 'capped' | 'taken' | 'not-due'> {
  const claim = await deps.breaker.claimProbe(breakerKey);
  if (claim === 'not-due') return claim;
  if (claim === 'taken') {
    deps.log?.('router', `${provider} restore probe already running in another lane — skipping it for this phase`);
    return claim;
  }
  const model = probeModelFor(order, provider, deps.router.registryRef, stageModel);
  try {
    await deps.probe(model);
  } catch (err) {
    const failure = routerFailureOf(err);
    if (failure?.reason === 'usage_cap') {
      const { cappedUntil } = await deps.breaker.recapAfterProbe(breakerKey, {
        reason: 'usage_cap',
        detail: failure.attempts.at(-1)?.detail,
      });
      deps.log?.('router', `${provider} restore probe hit the usage cap again — capped until ${cappedUntil}`);
    } else {
      const { cappedUntil } = await deps.breaker.recapAfterProbe(breakerKey);
      const why = failure?.reason ?? (err instanceof Error ? err.message : String(err));
      deps.log?.('router', `${provider} restore probe failed (${why}) — stays capped until ${cappedUntil}`);
    }
    return 'capped';
  }
  await deps.breaker.closeAfterProbe(breakerKey);
  deps.log?.('router', `${provider} passed the restore probe on ${model} — breaker closed (provider_restored: probe)`);
  return 'restored';
}

export async function probeDueProviders(deps: ProbeDeps, order: ProviderOrder, stage: FailoverStage): Promise<void> {
  for (const id of order[STAGE_ROLE[stage]]) {
    const def = deps.router.registryRef.get(id);
    const sub = subscriptionProviderOf(id, def);
    if (!def || !sub) continue;
    const result = await probeIfDue(deps, order, sub, def.provider, id);
    if (result === 'restored') return;
    if (result === 'not-due' && !(await deps.breaker.status(def.provider)).open) return;
  }
}
