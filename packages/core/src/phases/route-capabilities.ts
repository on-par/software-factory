import type { BuildRoutePin } from '../config/repo.js';
import type { EventKind } from '../events/kinds.js';
import { updateSpecRoute } from '../spec/index.js';

export interface RouteCapabilities {
  codexDisabled: boolean;
  codexBreakerOpen: boolean;
  localOnly: boolean;
}

export type RouteDegradeReason = 'codex-disabled' | 'breaker-open' | 'breaker-gate' | 'build-failover';

export function codexUnavailable(capabilities: RouteCapabilities | undefined): boolean {
  return !!capabilities && (capabilities.codexDisabled || capabilities.codexBreakerOpen);
}

export function resolveRoute<R extends BuildRoutePin>(
  plannedRoute: R,
  capabilities: RouteCapabilities,
): { route: R | 'claude'; reason?: RouteDegradeReason } {
  if (plannedRoute === 'codex' && codexUnavailable(capabilities)) {
    return { route: 'claude', reason: capabilities.codexDisabled ? 'codex-disabled' : 'breaker-open' };
  }
  return { route: plannedRoute };
}

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
