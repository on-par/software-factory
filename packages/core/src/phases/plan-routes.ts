// src/phases/plan-routes.ts — build-route helpers shared by PLAN and its prompt

import { type BuildRoutePin, routeForBuildModel } from '../config/repo.js';
import type { ModelRouter } from '../router/index.js';

export type BuildRouteName = 'codex' | 'claude' | 'opencode';

/** Order PLAN falls back through when its chosen route cannot run here. */
export const ROUTE_FALLBACK_ORDER: readonly BuildRouteName[] = ['claude', 'codex', 'opencode'];

/** Build routes whose task resolves to at least one runnable model, in fallback order.
 *  Returns [] when the router cannot answer, which callers treat as "no restriction". */
export function runnableBuildRoutes(router: Pick<ModelRouter, 'resolveAll'>): BuildRouteName[] {
  try {
    return ROUTE_FALLBACK_ORDER.filter((route) => router.resolveAll(`build_${route}`).length > 0);
  } catch {
    return [];
  }
}

/** The route PLAN should use when it chose none, or chose one that cannot run here. */
export function defaultBuildRoute(runnable: readonly BuildRouteName[]): BuildRouteName {
  return runnable[0] ?? 'claude';
}

/** Keep the requested route when it can run here (or the router cannot say); otherwise fall back. */
export function resolveRunnableBuildRoute(
  requested: BuildRouteName,
  runnable: readonly BuildRouteName[],
): { route: BuildRouteName; rerouted: boolean } {
  if (runnable.length === 0 || runnable.includes(requested)) return { route: requested, rerouted: false };
  return { route: defaultBuildRoute(runnable), rerouted: true };
}

/** The route and pin CHECK/CI rework runs on (#2873). codex/claude/opencode follow
 *  resolveRunnableBuildRoute and keep the pin unless rerouted (the pin belongs to the old route's
 *  harness). `command` is pin-only, so it is not in ROUTE_FALLBACK_ORDER: it stays when the pin sits
 *  on a declared agentic harness (pin kept) or build_command resolves a runnable model (router
 *  picks), and otherwise falls back without the pin. */
export function resolveReworkRoute(
  router: Pick<ModelRouter, 'resolveAll'> & Partial<Pick<ModelRouter, 'registryRef'>>,
  requested: BuildRoutePin,
  pinnedModel: string | undefined,
): { route: BuildRoutePin; rerouted: boolean; modelOverride?: string } {
  if (requested !== 'command') {
    const { route, rerouted } = resolveRunnableBuildRoute(requested, runnableBuildRoutes(router));
    return rerouted ? { route, rerouted } : { route, rerouted, modelOverride: pinnedModel };
  }
  if (pinFitsCommand(router, pinnedModel)) return { route: 'command', rerouted: false, modelOverride: pinnedModel };
  if (commandResolves(router)) return { route: 'command', rerouted: false };
  return { route: defaultBuildRoute(runnableBuildRoutes(router)), rerouted: true };
}

function pinFitsCommand(router: Partial<Pick<ModelRouter, 'registryRef'>>, model: string | undefined): boolean {
  try {
    return !!model && !!router.registryRef && routeForBuildModel(router.registryRef, model) === 'command';
  } catch {
    return false;
  }
}

function commandResolves(router: Pick<ModelRouter, 'resolveAll'>): boolean {
  try {
    return router.resolveAll('build_command').length > 0;
  } catch {
    return false;
  }
}

/** Step-3 route bullets, in display order. */
export const ROUTE_BULLETS: Record<BuildRouteName, string> = {
  codex: `   - route: codex — when the implementation from a frozen spec is bounded and mechanical
     (known-repro fixes, well-scoped features, refactors, test writing, CI/tooling)`,
  claude: `   - route: claude — when the work needs UX, design, or architecture judgment; naming/API
     design calls; is a tiny diff (<20 lines); needs session tools; or when the repo's
     pinned build worker is a claude-cli model (e.g. claude-sonnet-5 in .factory/config.json)`,
  opencode: `   - route: opencode — when the repo's pinned build worker is an opencode-harness model
     (e.g. opencode-deepseek-v4-flash in .factory/config.json); bounded mechanical work`,
};
