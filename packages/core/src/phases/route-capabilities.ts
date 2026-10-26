import type { BuildRoutePin } from '../config/repo.js';
import type { EventKind } from '../events/kinds.js';
import { updateSpecRoute } from '../spec/index.js';

/** What a lane's build route may use, built once per lane and handed to both PLAN and BUILD (#664). */
export interface RouteCapabilities {
  codexDisabled: boolean;
  codexBreakerOpen: boolean;
  localOnly: boolean;
}

export type RouteDegradeReason = 'codex-disabled' | 'breaker-open' | 'breaker-gate' | 'build-failover';

export function codexUnavailable(capabilities: RouteCapabilities | undefined): boolean {
  return !!capabilities && (capabilities.codexDisabled || capabilities.codexBreakerOpen);
}

/** The one place the "codex unavailable → claude" rule lives. Pure: callers persist the change. */
export function resolveRoute<R extends BuildRoutePin>(
  plannedRoute: R,
  capabilities: RouteCapabilities,
): { route: R | 'claude'; reason?: RouteDegradeReason } {
  if (plannedRoute === 'codex' && codexUnavailable(capabilities)) {
    return { route: 'claude', reason: capabilities.codexDisabled ? 'codex-disabled' : 'breaker-open' };
  }
  return { route: plannedRoute };
}

/** Keep the frozen spec's `route` equal to the route that actually builds the issue. */
export async function recordRouteDegradation(opts: {
  specPath: string;
  specRoute: BuildRoutePin;
  actualRoute: BuildRoutePin;
  reason: RouteDegradeReason;
  log: (type: EventKind, msg: string) => void;
}): Promise<boolean> {
  const { specPath, specRoute, actualRoute, reason, log } = opts;
  if (specRoute === actualRoute) return false;
  await updateSpecRoute(specPath, actualRoute, reason);
  log('route-degraded', `build route ${specRoute} → ${actualRoute} (${reason}); spec frontmatter updated`);
  return true;
}
