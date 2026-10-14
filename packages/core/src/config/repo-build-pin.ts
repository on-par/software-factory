// src/config/repo-build-pin.ts — BUILD pin validation and the build route a pin implies.

import type { ModelRegistry } from '../models/index.js';
import type { EffectiveModelPins, RepoFactoryConfig } from './repo.js';

/** BUILD edits files, so a build pin must run on an agentic harness (#2871). */
export function assertAgenticBuildPin(registry: ModelRegistry, label: string, model: string): void {
  const harnessId = registry.getHarnessId(model) ?? '';
  if (registry.isAgenticHarnessId(harnessId)) return;
  const fix = registry.getHarnessDeclaration(harnessId)
    ? `set agentic: true under harnesses.${harnessId}, or pin a model on claude-cli, codex-cli or opencode`
    : 'pin a model on claude-cli, codex-cli or opencode';
  throw new Error(
    `${label} '${model}' runs on harness '${harnessId}', which is not agentic; BUILD needs an agentic harness (${fix})`,
  );
}

/** Same literal union as run/outcome.ts's BuildRoute; kept local so config/ never imports run/. */
export type BuildRoutePin = 'codex' | 'claude' | 'opencode';

/** The build route a pinned build model implies, read from its harness: a Codex-harness model
 *  can only run on the codex route, an opencode-harness model on opencode, a claude-cli model on
 *  claude. `undefined` when there is no pin or the harness has no dedicated route (#1367). */
export function routeForBuildModel(registry: ModelRegistry, modelId: string | undefined): BuildRoutePin | undefined {
  if (!modelId || !registry.get(modelId)) return undefined;
  if (registry.isCodexModel(modelId)) return 'codex';
  const harness = registry.getHarnessId(modelId);
  if (harness === 'opencode') return 'opencode';
  if (harness === 'claude-cli') return 'claude';
  return undefined;
}

export interface EffectiveBuildRoute {
  route?: BuildRoutePin;
  /** 'repo' = explicit `route` in .factory/config.json; 'build-pin' = derived from the pinned
   *  build model's harness; 'plan' = nothing pinned, the PLAN model decides per issue. */
  source: 'repo' | 'build-pin' | 'plan';
}

/** An explicit repo `route` wins; otherwise a pinned build model determines the route, so an
 *  operator who pins an Anthropic worker keeps BUILD on Anthropic without also learning about
 *  `route`. With neither, PLAN decides (#1367). */
export function resolveEffectiveBuildRoute(
  registry: ModelRegistry,
  repo: RepoFactoryConfig | null,
  pins: EffectiveModelPins,
): EffectiveBuildRoute {
  if (repo?.route) return { route: repo.route, source: 'repo' };
  const derived = routeForBuildModel(registry, pins.build);
  return derived ? { route: derived, source: 'build-pin' } : { source: 'plan' };
}
