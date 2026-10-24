// packages/cli/src/cli/repo-router.ts — the one-off repo model router for `factory check --deep` and
// `factory init --detect-checks`, moved out of index.ts.

import {
  applyRepoConfig,
  getFactoryPaths,
  type loadFactoryConfigForRepo,
  type loadModelsConfig,
  type loadRepoConfig,
  type loadRoutesConfig,
  type ModelRouter,
} from '@on-par/factory-core';
import { recordLocalAuthFailure, resolveEffectiveConfig } from '@on-par/factory-core/internal';

/** The config loaders the router reads; index.ts passes its resolved (test-overridable) instances. */
export interface RepoRouterLoaders {
  loadRepoConfig: typeof loadRepoConfig;
  loadModelsConfig: typeof loadModelsConfig;
  loadRoutesConfig: typeof loadRoutesConfig;
  loadFactoryConfigForRepo: typeof loadFactoryConfigForRepo;
}

/** A model router for a one-off CLI model call in this repo (repo config, sandbox and local-auth applied). */
export function newRepoRouter(repoRoot: string, loaders: RepoRouterLoaders, Router: typeof ModelRouter): ModelRouter {
  const repoConfig = loaders.loadRepoConfig(repoRoot);
  const effective = resolveEffectiveConfig(repoConfig);
  const router = new Router(
    applyRepoConfig(loaders.loadModelsConfig(), repoConfig),
    loaders.loadRoutesConfig(),
    false,
    undefined,
    effective.allowExperimental,
    effective.localOnly,
  );
  router.setCodexFullAccessTasks?.(
    loaders.loadFactoryConfigForRepo(getFactoryPaths(repoRoot).config).sandbox.codexFullAccessTasks,
  );
  router.setLocalAuthSink?.(recordLocalAuthFailure);
  return router;
}

/** The router wiring every CLI model router shares: the local-auth sink and the metered failover guard (#3234). */
export function applyRouterGuards(router: ModelRouter): void {
  router.setLocalAuthSink?.(recordLocalAuthFailure);
  router.setProviderPlanDeps?.({});
}
