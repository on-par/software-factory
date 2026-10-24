// src/utils/subscription-login.ts — refuse metered logins for failover (#3335).
// A per-provider login check plus one filter over `models.providerOrder`. Failover runs unattended,
// so a provider signed in with an API key (or with no detectable subscription login) is dropped from
// every role and logged once as `provider_refused`. Nothing here ever reads a credential value into
// a message or payload. Built on the #3214 detectors in provider-plan.ts.

import {
  PROVIDER_ORDER_ROLES,
  subscriptionProviderOf,
  type ProviderModelDef,
  type ProviderOrder,
  type SubscriptionProviderId,
} from '../config/provider-order.js';
import type { EventKind } from '../events/kinds.js';
import type { ProviderRefusedPayload } from '../events/payloads.js';
import type { ProviderPlan } from './claude-config.js';
import { detectProviderPlan, type ProviderPlanDeps } from './provider-plan.js';

export type SubscriptionLogin = ProviderPlan;

export interface SubscriptionLoginDeps extends ProviderPlanDeps {
  /** Receives one `provider_refused` event per refused provider (once per process). */
  log?: (type: EventKind, msg: string, extra?: { providerRefused?: ProviderRefusedPayload }) => void;
  /** Providers already logged. Default: a module-level set shared by the process. */
  logged?: Set<string>;
}

export interface RefusedProvider {
  provider: string;
  login: 'api' | 'unknown';
  /** The dropped model ids, first seen first. */
  models: string[];
}

const loggedRefusals = new Set<string>();

/** The login kind behind a failover provider. OpenCode Go is a subscription; its model prefix is judged by the filter. Never throws. */
export function subscriptionLogin(
  providerId: SubscriptionProviderId,
  deps: SubscriptionLoginDeps = {},
): SubscriptionLogin {
  if (providerId === 'opencode-go') return 'subscription';
  if (providerId === 'claude' || providerId === 'codex') return detectProviderPlan(providerId, deps);
  return 'unknown';
}

/** Drops every provider whose login is `api` or `unknown`, and any opencode model that is not `opencode-go/`,
 *  from every role. Logs `provider_refused` once per process per provider. Does not mutate `order`.
 *  A role may come back empty. */
export function filterRefusedProviders(
  order: ProviderOrder,
  models: Record<string, ProviderModelDef>,
  deps: SubscriptionLoginDeps = {},
): { order: ProviderOrder; refused: RefusedProvider[] } {
  const logins = new Map<SubscriptionProviderId, SubscriptionLogin>();
  const refusedBy = new Map<string, RefusedProvider>();
  const refuse = (provider: string, login: 'api' | 'unknown', id: string): void => {
    const entry = refusedBy.get(provider);
    if (!entry) refusedBy.set(provider, { provider, login, models: [id] });
    else if (!entry.models.includes(id)) entry.models.push(id);
  };
  const filtered = { boss: [], worker: [], checker: [], triage: [] } as ProviderOrder;
  for (const role of PROVIDER_ORDER_ROLES) {
    for (const id of order[role]) {
      const def = models[id];
      const provider = subscriptionProviderOf(id, def);
      if (provider === undefined) {
        if (def?.harness === 'opencode') refuse('opencode-go', 'api', id);
        else refuse(def?.harness ?? id, 'unknown', id);
        continue;
      }
      let login = logins.get(provider);
      if (login === undefined) {
        login = subscriptionLogin(provider, deps);
        logins.set(provider, login);
      }
      if (login === 'subscription') filtered[role].push(id);
      else refuse(provider, login, id);
    }
  }
  const refused = [...refusedBy.values()];
  const logged = deps.logged ?? loggedRefusals;
  for (const { provider, login } of refused) {
    if (logged.has(provider)) continue;
    logged.add(provider);
    const why = login === 'api' ? 'signed in with an API key (metered)' : 'no subscription login found';
    deps.log?.('provider_refused', `${provider} refused for failover: ${why}; never run from models.providerOrder`, {
      providerRefused: { provider, login, at: new Date((deps.now ?? Date.now)()).toISOString() },
    });
  }
  return { order: filtered, refused };
}
