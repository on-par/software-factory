import type { ModelRegistry } from '../models/index.js';
import type { EffectiveModelPins, RepoFactoryConfig } from './repo.js';

/** Same literal union as run/outcome.ts's BuildRoute; kept local so config/ never imports run/. */
export type BuildRoutePin = 'codex' | 'claude' | 'opencode' | 'command';

/** The build route a pinned build model implies, read from its harness: declared agentic harness or Pi →
 *  command (wins over `codex: true`), codex-harness → codex, opencode → opencode, claude-cli → claude.
 *  `undefined` when there is no pin or the harness has no dedicated route (#1367). */
export function routeForBuildModel(registry: ModelRegistry, modelId: string | undefined): BuildRoutePin | undefined {
  if (!modelId || !registry.get(modelId)) return undefined;
  const harness = registry.getHarnessId(modelId);
  if (harness && registry.ridesCommandRoute(harness)) return 'command';
  if (registry.isCodexModel(modelId)) return 'codex';
  if (harness === 'opencode') return 'opencode';
  return harness === 'claude-cli' ? 'claude' : undefined;
}

export interface EffectiveBuildRoute {
  route?: BuildRoutePin;
  /** 'repo' = explicit `route` in .factory/config.json; 'local-only' = FACTORY_LOCAL_ONLY forces the
   *  local codex harness (claude when codex is disabled, as settlePlanRoute does); 'build-pin' = derived
   *  from the pinned build model's harness; 'plan' = nothing usable pinned, PLAN decides per issue. */
  source: 'repo' | 'local-only' | 'build-pin' | 'plan';
  /** Short human reason, e.g. why a build pin was not used. */
  note?: string;
}

export interface BuildRouteDecisionInput {
  repoRoute?: BuildRoutePin;
  buildPin?: string;
  localOnly?: boolean;
  codexDisabled?: boolean;
}

/** The one build-route decision shared by runIssue, `factory status` and the usage-watchdog setup.
 *  Precedence: explicit repo route, then local-only mode, then the build pin's harness (a codex pin is
 *  dropped while codex is disabled), then PLAN decides (#1367, ADR-0092). */
export function decideBuildRoute(registry: ModelRegistry, input: BuildRouteDecisionInput): EffectiveBuildRoute {
  if (input.repoRoute) return { route: input.repoRoute, source: 'repo' };
  if (input.localOnly) {
    return input.codexDisabled
      ? { route: 'claude', source: 'local-only', note: 'codex disabled — local-only falls back to claude' }
      : { route: 'codex', source: 'local-only' };
  }
  const derived = routeForBuildModel(registry, input.buildPin);
  if (derived === 'codex' && input.codexDisabled) {
    return {
      source: 'plan',
      note: `pinned build model ${input.buildPin} needs the codex route but codex is disabled — the pin cannot force it`,
    };
  }
  return derived ? { route: derived, source: 'build-pin' } : { source: 'plan' };
}

/** An explicit repo `route` wins; otherwise a pinned build model determines the route, so an
 *  operator who pins an Anthropic worker keeps BUILD on Anthropic without also learning about
 *  `route`. With neither, PLAN decides (#1367). */
export function resolveEffectiveBuildRoute(
  registry: ModelRegistry,
  repo: RepoFactoryConfig | null,
  pins: EffectiveModelPins,
  flags?: { localOnly?: boolean; codexDisabled?: boolean },
): EffectiveBuildRoute {
  return decideBuildRoute(registry, {
    repoRoute: repo?.route,
    buildPin: pins.build,
    localOnly: flags?.localOnly,
    codexDisabled: flags?.codexDisabled,
  });
}
