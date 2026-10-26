import type { BuildRoutePin } from '../config/repo.js';
import type { EventKind } from '../events/kinds.js';
import { updateSpecRoute } from '../spec/index.js';
import { type BuildRouteName, defaultBuildRoute, resolveRunnableBuildRoute } from './plan-routes.js';
import { resolveRoute, type RouteCapabilities } from './route-capabilities.js';

/** Settle the build route after PLAN: the planner's choice, then local-only / codex-disabled /
 *  unrunnable-route fallbacks, then the repo pin. The persisted spec's frontmatter is kept in sync,
 *  since it's the frozen artifact downstream consumers (eval scoring, PR review) read. */
export async function settlePlanRoute(opts: {
  parsedRoute: BuildRoutePin | null;
  runnableNow: readonly BuildRouteName[];
  capabilities: RouteCapabilities;
  preferredRoute?: BuildRoutePin;
  specPath: string;
  log: (type: EventKind, msg: string) => void;
}): Promise<BuildRoutePin> {
  const { parsedRoute, runnableNow, capabilities, preferredRoute, specPath, log } = opts;
  // A planner-written command is kept only when build_command can run here (#2874).
  const commandRunnable = runnableNow.includes('command');
  let planned: BuildRouteName =
    (parsedRoute === 'command' && !commandRunnable ? undefined : parsedRoute) ?? defaultBuildRoute(runnableNow);

  if (capabilities.localOnly && planned !== 'codex') {
    log('warn', 'local-only mode requires a local Codex harness — forcing route to codex');
    planned = 'codex';
    await updateSpecRoute(specPath, 'codex', 'local-only');
  }

  const degraded = resolveRoute(planned, capabilities);
  if (degraded.reason) {
    log('warn', 'codex unavailable — falling back to claude');
    planned = degraded.route as BuildRouteName;
    await updateSpecRoute(specPath, degraded.route, degraded.reason);
  }

  const resolved = resolveRunnableBuildRoute(planned, runnableNow);
  if (resolved.rerouted) {
    const next = resolved.route;
    log('model-override', `route ${planned} has no runnable model on this machine, rerouting to ${next}`);
    planned = next;
    await updateSpecRoute(specPath, next, 'route-unavailable');
  }

  if (preferredRoute && planned !== preferredRoute) {
    log('model-override', `pinned build route ${preferredRoute} — overriding plan's ${planned}`);
    await updateSpecRoute(specPath, preferredRoute, 'repo-config-pin');
    return preferredRoute;
  }
  // The spec still names the command route the planner wrote but could not run: record the route actually used.
  if (parsedRoute === 'command' && planned !== 'command') await updateSpecRoute(specPath, planned, 'route-unavailable');
  return planned;
}
