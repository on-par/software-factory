// packages/core/src/config/provider-order.ts — Per-role subscription provider order (#3334)
//
// `models.providerOrder` lists, per role, the subscription providers (claude, codex,
// opencode-go) in failover order as model ids, at most one model per provider. Pure
// classification, derivation, validation and lookup; nothing here does I/O. Nothing
// switches providers from it yet (#3338).

import { defaultModelsConfig } from '@on-par/factory-config';
import { z } from 'zod';

import { retiredModelHint } from '../models/overrides.js';

export const PROVIDER_ORDER_ROLES = ['boss', 'worker', 'checker', 'triage'] as const;
export type ProviderOrderRole = (typeof PROVIDER_ORDER_ROLES)[number];
export const SUBSCRIPTION_PROVIDERS = ['claude', 'codex', 'opencode-go'] as const;
export type SubscriptionProviderId = (typeof SUBSCRIPTION_PROVIDERS)[number];
export type ProviderOrder = Record<ProviderOrderRole, string[]>;

/** Structural subset of a registry entry, so packaged ModelDefaults and core ModelDefinition both fit. */
export interface ProviderModelDef {
  harness?: string;
  providerModel?: string;
  endpoint?: string;
}

export interface ProviderOrderIssue {
  role: ProviderOrderRole;
  index: number;
  message: string;
}

/** The opencode-go slot of a derived order. */
export const OPENCODE_GO_DEFAULT_MODEL = 'opencode-deepseek-v4-flash';

export const PROVIDER_ORDER_DESCRIPTION =
  "Per role (boss, worker, checker, triage): subscription providers in failover order, as model ids, at most one per provider (claude, codex, opencode-go). Unset role: today's tier order for that role with opencode-go last. OpenCode Zen (opencode/) models are refused. Not used for run-time failover yet.";

/** Per-role override shape for the repo file: every role optional, unknown roles rejected. */
export const ProviderOrderOverrideSchema = z
  .object({
    boss: z.array(z.string()).optional().describe('Boss providers in failover order.'),
    worker: z.array(z.string()).optional().describe('Worker providers in failover order.'),
    checker: z.array(z.string()).optional().describe('Checker providers in failover order.'),
    triage: z.array(z.string()).optional().describe('Triage providers in failover order.'),
  })
  .strict();

/** True for an OpenCode Zen (metered, `opencode/`) model. `opencode-go/` does not match. */
export function isOpenCodeZenModel(id: string, def?: ProviderModelDef): boolean {
  return id.startsWith('opencode/') || (def?.providerModel?.startsWith('opencode/') ?? false);
}

/** The subscription provider that serves a model, or undefined for Zen and non-subscription models. */
export function subscriptionProviderOf(
  id: string,
  def: ProviderModelDef | undefined,
): SubscriptionProviderId | undefined {
  if (!def || isOpenCodeZenModel(id, def)) return undefined;
  if (def.harness === 'claude-cli' && !def.endpoint) return 'claude';
  if (def.harness === 'codex-cli') return 'codex';
  if (def.harness === 'opencode' && def.providerModel?.startsWith('opencode-go/')) return 'opencode-go';
  return undefined;
}

/** Today's tier order per role: the first model of each subscription provider, opencode-go last. */
export function deriveProviderOrder(
  tiers: Record<string, string[]>,
  models: Record<string, ProviderModelDef>,
): ProviderOrder {
  const order = {} as ProviderOrder;
  for (const role of PROVIDER_ORDER_ROLES) {
    const seen = new Set<SubscriptionProviderId>();
    const ids: string[] = [];
    for (const id of tiers[role] ?? []) {
      const provider = subscriptionProviderOf(id, models[id]);
      if (!provider || provider === 'opencode-go' || seen.has(provider)) continue;
      seen.add(provider);
      ids.push(id);
    }
    order[role] = [...ids, OPENCODE_GO_DEFAULT_MODEL];
  }
  return order;
}

/** Validate the roles present in `order` against the registry. Reports the first problem per entry. */
export function providerOrderIssues(
  order: Partial<Record<ProviderOrderRole, readonly string[]>>,
  models: Record<string, ProviderModelDef>,
): ProviderOrderIssue[] {
  const issues: ProviderOrderIssue[] = [];
  for (const role of PROVIDER_ORDER_ROLES) {
    const ids = order[role];
    if (!ids) continue;
    if (ids.length === 0) {
      issues.push({ role, index: 0, message: `models.providerOrder.${role}: list at least one model` });
      continue;
    }
    const firstOf = new Map<SubscriptionProviderId, string>();
    ids.forEach((id, index) => {
      const p = `models.providerOrder.${role}[${index}]`;
      const def = models[id];
      const provider = subscriptionProviderOf(id, def);
      let message: string | undefined;
      if (isOpenCodeZenModel(id, def)) {
        message = `${p}: '${id}' is an OpenCode Zen (opencode/) model. Zen is metered pay-per-use and is never a providerOrder entry. Use an OpenCode Go model such as '${OPENCODE_GO_DEFAULT_MODEL}'`;
      } else if (!def) {
        message = `${p}: unknown model '${id}'${retiredModelHint(id)}`;
      } else if (!provider) {
        message = `${p}: '${id}' is not a subscription CLI model (claude, codex or opencode-go)`;
      } else if (firstOf.has(provider)) {
        message = `${p}: '${id}' is a second ${provider} model in ${role} (already listed: '${firstOf.get(provider)}'). List at most one model per provider`;
      } else {
        firstOf.set(provider, id);
      }
      if (message) issues.push({ role, index, message });
    });
  }
  return issues;
}

/** The role's model for a provider, or undefined. Never returns another provider's model. */
export function resolveRoleModel(
  order: ProviderOrder,
  role: ProviderOrderRole,
  providerId: SubscriptionProviderId,
  models: Record<string, ProviderModelDef> = defaultModelsConfig.models,
): string | undefined {
  return order[role].find((id) => subscriptionProviderOf(id, models[id]) === providerId);
}
