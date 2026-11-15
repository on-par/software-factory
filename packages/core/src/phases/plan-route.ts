import type { BuildRoutePin } from '../config/repo.js';
import type { EventKind } from '../events/kinds.js';
import { updateSpecRoute } from '../spec/index.js';
import { type BuildRouteName, defaultBuildRoute, resolveRunnableBuildRoute } from './plan-routes.js';
import { resolveRoute, type RouteCapabilities } from './route-capabilities.js';

export async function settlePlanRoute(opts: {
  parsedRoute: BuildRoutePin | null;
  runnableNow: readonly BuildRouteName[];
  capabilities: RouteCapabilities;
  preferredRoute?: BuildRoutePin;
  specPath: string;
  log: (type: EventKind, msg: string) => void;
}): Promise<BuildRoutePin> {
  const { parsedRoute, runnableNow, capabilities, preferredRoute, specPath, log } = opts;
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
    planned = degraded.route;
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
  const specStillNamesUnrunnableCommand = parsedRoute === 'command' && planned !== 'command';
  if (specStillNamesUnrunnableCommand) await updateSpecRoute(specPath, planned, 'route-unavailable');
  return planned;
}
