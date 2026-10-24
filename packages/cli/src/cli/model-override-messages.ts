// packages/cli/src/cli/model-override-messages.ts — the `model-override` lines shipIssue logs, split from ship.ts

import type { EffectiveModelPins, ModelRouter, ModelsConfig, RepoFactoryConfig } from '@on-par/factory-core';
import {
  filterRefusedProviders,
  meteredPrimaryRouteWarnings,
  type ProviderOrder,
  type SubscriptionLoginDeps,
} from '@on-par/factory-core/internal';

/** One `model-override` message per pinned phase, naming the file or env var it came from (#2497). */
export function modelOverrideMessages(
  pins: EffectiveModelPins,
  repo: RepoFactoryConfig | null,
  repoConfigLabel: string,
): string[] {
  const label = (source: 'repo' | 'env' | undefined, envVar: string) => (source === 'repo' ? repoConfigLabel : envVar);
  const repoPins = repo?.models?.pins;
  return [
    ...(repoPins?.triage ? [`triage model pinned to ${repoPins.triage} (${repoConfigLabel})`] : []),
    ...(pins.plan ? [`plan model pinned to ${pins.plan} (${label(pins.sources.plan, 'FACTORY_PLAN_MODEL')})`] : []),
    ...(pins.build
      ? [`build model pinned to ${pins.build} (${label(pins.sources.build, 'FACTORY_BUILD_MODEL')})`]
      : []),
    ...(repoPins?.checker ? [`checker model pinned to ${repoPins.checker} (${repoConfigLabel})`] : []),
  ];
}

/** Turn on the metered failover guard and log one `metered_primary_route` warning per metered plan/build pin (#3234). */
export function applyMeteredGuard(
  router: ModelRouter,
  pins: EffectiveModelPins,
  log: (type: 'warn', msg: string) => void,
): void {
  router.setProviderPlanDeps?.({});
  const registry = router.registryRef;
  const lookup = (m: string) => {
    const def = registry?.get(m);
    return def && { ...def, harness: registry?.getHarnessId(m) };
  };
  for (const msg of meteredPrimaryRouteWarnings(pins, lookup)) log('warn', msg);
}

/** The run's provider order (#3338): only when the repo file sets `models.providerOrder`, with refused providers
 *  filtered out (#3335); undefined leaves every phase on today's routing. */
export function resolveProviderOrder(
  repo: RepoFactoryConfig | null,
  models: ModelsConfig,
  log: SubscriptionLoginDeps['log'],
): ProviderOrder | undefined {
  // applyRepoConfig merges the repo's override over the derived order, so it is set whenever the repo file sets the key.
  if (!repo?.models?.providerOrder || !models.providerOrder) return undefined;
  return filterRefusedProviders(models.providerOrder as ProviderOrder, models.models, { log }).order;
}
