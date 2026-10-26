import type { BuildRoutePin } from '../config/repo.js';
import type { EventKind } from '../events/kinds.js';
import type { RouteCapabilities, RouteDegradeReason } from '../phases/route-capabilities.js';
import { recordRouteDegradation, resolveRoute } from '../phases/route-capabilities.js';
import type { ProviderBreaker } from '../router/breaker.js';
import type { ModelRouter } from '../router/index.js';
import { routeForBuildModel } from '../config/repo.js';
import { codexBuildBlocked } from './provider-breaker-gate.js';

type Log = (type: EventKind, msg: string) => void;

/** The lane's RouteCapabilities, built once before PLAN (#664). The breaker is probed only when failover is on. */
export async function laneRouteCapabilities(
  request: { codexDisabled: boolean; localOnly?: boolean; failover: { enabled: boolean } },
  ports: { router: ModelRouter; breaker: ProviderBreaker },
  log: Log,
): Promise<RouteCapabilities> {
  return {
    codexDisabled: request.codexDisabled,
    localOnly: !!request.localOnly,
    codexBreakerOpen: request.failover.enabled && (await codexBuildBlocked(ports.router, ports.breaker, log)),
  };
}

/** Tracks the route the frozen spec currently names and rewrites it whenever the route in use differs. */
export function specRouteTracker(specPath: string, initial: BuildRoutePin, log: Log) {
  let current = initial;
  return async (actual: BuildRoutePin, reason: RouteDegradeReason): Promise<void> => {
    try {
      if (await recordRouteDegradation({ specPath, specRoute: current, actualRoute: actual, reason, log })) {
        current = actual;
      }
    } catch (err) {
      // A spec that cannot be rewritten must not stop the build; the next sync retries against the same route.
      log(
        'warn',
        `could not update spec route to ${actual} (${reason}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };
}

/** Degrade the frozen route for BUILD: a breaker that opened after PLAN flips codex to claude and is persisted. */
export async function beginBuildRoute(
  request: { failover: { enabled: boolean }; specPath: string },
  ports: { router: ModelRouter; breaker: ProviderBreaker; events: (phase: 'build') => Log },
  routeCaps: RouteCapabilities,
  specRoute: BuildRoutePin,
) {
  const log = ports.events('build');
  const blocked = request.failover.enabled && (await codexBuildBlocked(ports.router, ports.breaker, log));
  const buildCaps = blocked && !routeCaps.codexBreakerOpen ? { ...routeCaps, codexBreakerOpen: true } : routeCaps;
  const syncSpecRoute = specRouteTracker(request.specPath, specRoute, log);
  const resolved = resolveRoute(specRoute, buildCaps);
  if (resolved.reason) await syncSpecRoute(resolved.route, resolved.reason);
  return { buildCaps, syncSpecRoute, route: resolved.route };
}

/** Drop a build model whose harness does not match the route that will run it (a pin cannot force the route). */
export function compatibleBuildModel(
  registry: Parameters<typeof routeForBuildModel>[0],
  model: string | undefined,
  route: BuildRoutePin,
  preferredRoute: BuildRoutePin | undefined,
  log: Log,
): string | undefined {
  if (!model || routeForBuildModel(registry, model) === route) return model;
  log(
    'model_override_ignored',
    `build model ${model} is incompatible with the ${route} route${
      route === preferredRoute ? ' pinned by .factory/config.json' : ''
    } — using that route's default worker`,
  );
  return undefined;
}
