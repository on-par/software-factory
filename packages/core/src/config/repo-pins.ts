// src/config/repo-pins.ts — Effective plan/build model pins (repo file > env), split out of repo.ts (max-lines baseline).

import type { ModelRegistry } from '../models/index.js';
import { resolveModelOverrides, retiredModelHint } from '../models/index.js';
import { assertAgenticBuildPin } from './repo-build-pin.js';
import { repoConfigLabel } from './repo-config-label.js';
import type { RepoFactoryConfig } from './repo.js';

export interface EffectiveModelPins {
  plan?: string;
  planFallback?: string;
  build?: string;
  buildFallback?: string;
  sources: { plan?: 'repo' | 'env'; planFallback?: 'repo'; build?: 'repo' | 'env'; buildFallback?: 'repo' };
}

/** Resolve plan/build model pins: repo file overrides env vars
 *  (FACTORY_PLAN_MODEL/FACTORY_BUILD_MODEL), which override no pin at all.
 *  `resolveModelOverrides` itself is untouched; this layers the repo file on top. */
export function resolveEffectiveModelPins(
  registry: ModelRegistry,
  repo: RepoFactoryConfig | null,
  env: NodeJS.ProcessEnv = process.env,
): EffectiveModelPins {
  const label = repoConfigLabel(repo);
  const envOverrides = resolveModelOverrides(registry, env);
  const sources: EffectiveModelPins['sources'] = {};
  let plan = envOverrides.plan;
  if (plan) sources.plan = 'env';
  let build = envOverrides.build;
  if (build) sources.build = 'env';

  if (repo?.models?.pins?.plan) {
    if (!registry.get(repo.models.pins.plan)) {
      throw new Error(
        `${label}: models.pins.plan references unknown model '${repo.models.pins.plan}' (known models: ${registry.list().join(', ')})${retiredModelHint(repo.models.pins.plan)}`,
      );
    }
    plan = repo.models.pins.plan;
    sources.plan = 'repo';
  }
  let planFallback: string | undefined;
  if (repo?.models?.pins?.planFallback) {
    if (!registry.get(repo.models.pins.planFallback)) {
      throw new Error(
        `${label}: models.pins.planFallback references unknown model '${repo.models.pins.planFallback}' (known models: ${registry.list().join(', ')})${retiredModelHint(repo.models.pins.planFallback)}`,
      );
    }
    planFallback = repo.models.pins.planFallback;
    sources.planFallback = 'repo';
  }
  if (repo?.models?.pins?.build) {
    if (!registry.get(repo.models.pins.build)) {
      throw new Error(
        `${label}: models.pins.build references unknown model '${repo.models.pins.build}' (known models: ${registry.list().join(', ')})${retiredModelHint(repo.models.pins.build)}`,
      );
    }
    build = repo.models.pins.build;
    sources.build = 'repo';
  }
  if (build) assertAgenticBuildPin(registry, build, sources.build, 'build', label);
  let buildFallback: string | undefined;
  if (repo?.models?.pins?.buildFallback) {
    if (!registry.get(repo.models.pins.buildFallback)) {
      throw new Error(
        `${label}: models.pins.buildFallback references unknown model '${repo.models.pins.buildFallback}' (known models: ${registry.list().join(', ')})${retiredModelHint(repo.models.pins.buildFallback)}`,
      );
    }
    if (!registry.isCodexModel(repo.models.pins.buildFallback)) {
      throw new Error(
        `${label}: models.pins.buildFallback must be a Codex-capable model because it is used after Claude build failure`,
      );
    }
    assertAgenticBuildPin(registry, repo.models.pins.buildFallback, 'repo', 'buildFallback', label);
    buildFallback = repo.models.pins.buildFallback;
    sources.buildFallback = 'repo';
  }

  return {
    ...(plan ? { plan } : {}),
    ...(planFallback ? { planFallback } : {}),
    ...(build ? { build } : {}),
    ...(buildFallback ? { buildFallback } : {}),
    sources,
  };
}
