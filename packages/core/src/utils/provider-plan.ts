// src/utils/provider-plan.ts — the billing plan (flat subscription vs metered API) per failover provider.
// A leaf: imports only the claude and codex config modules.

import { detectClaudePlan, type ClaudeLoginEvidenceDeps, type ProviderPlan } from './claude-config.js';
import { codexHasApiKey, hasCodexLoginEvidence, type CodexLoginEvidenceDeps } from './codex-config.js';

// The internal surface for #3214 (reached through config/provider-order-exports.ts).
export { detectClaudePlan, codexHasApiKey };
export type { ProviderPlan };

export type ProviderPlanDeps = ClaudeLoginEvidenceDeps & CodexLoginEvidenceDeps;

/** The billing plan for a failover provider (#3214, for #3234). `id` is a provider id
 *  ('anthropic' | 'claude' | 'codex' | 'openai' | 'opencode-go') or an OpenCode provider-model id.
 *  Any API key counts as metered. OpenCode Go is a flat subscription even though its auth.json entry
 *  is {"type":"api"}; Zen (opencode/) is metered. Anything else is 'unknown'. Matching is
 *  case-sensitive. Never throws. */
export function detectProviderPlan(id: string, deps: ProviderPlanDeps = {}): ProviderPlan {
  try {
    const key = id.trim();
    if (key === 'anthropic' || key === 'claude') return detectClaudePlan(deps);
    if (key === 'codex' || key === 'openai') {
      if (codexHasApiKey(deps)) return 'api';
      return hasCodexLoginEvidence(deps) ? 'subscription' : 'unknown';
    }
    if (key === 'opencode-go' || key.startsWith('opencode-go/')) return 'subscription';
    if (key.startsWith('opencode/')) return 'api';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/** The registry fields providerPlan reads. Never a credential. */
export interface ProviderPlanModel {
  harness?: string;
  providerModel?: string;
  endpoint?: string;
}

/** The billing plan of one routed model (#3234). The harness wins; with no harness, provider
 *  'anthropic' means claude-cli and 'openai' means codex-cli. Zen (opencode/) is 'api', opencode-go/
 *  is 'subscription', a claude-cli model with an endpoint and any other harness (pi, ollama, command)
 *  is 'unknown'. Never throws, never reads a credential value into a return or log. */
export function providerPlan(
  provider: string | undefined,
  model: ProviderPlanModel | undefined,
  deps: ProviderPlanDeps = {},
): ProviderPlan {
  try {
    const harness =
      model?.harness ?? (provider === 'anthropic' ? 'claude-cli' : provider === 'openai' ? 'codex-cli' : undefined);
    if (model?.providerModel?.startsWith('opencode/')) return 'api';
    if (harness === 'opencode') return detectProviderPlan(model?.providerModel ?? '', deps);
    if (harness === 'claude-cli') return model?.endpoint ? 'unknown' : detectProviderPlan('claude', deps);
    if (harness === 'codex-cli') return detectProviderPlan('codex', deps);
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/** One `metered_primary_route:` line per pinned plan/build route whose model is not on a subscription (#3234). */
export function meteredPrimaryRouteWarnings(
  pins: { plan?: string; build?: string },
  lookup: (model: string) => (ProviderPlanModel & { provider?: string }) | undefined,
  deps: ProviderPlanDeps = {},
): string[] {
  const lines = new Set<string>();
  for (const route of ['plan', 'build'] as const) {
    const model = pins[route];
    if (!model) continue;
    const def = lookup(model);
    const plan = providerPlan(def?.provider, def, deps);
    if (plan === 'subscription') continue;
    lines.add(
      `metered_primary_route: ${route} is pinned to ${model} (plan ${plan}, metered); it runs because it is the explicit primary, and is never used as a failover target`,
    );
  }
  return [...lines];
}
