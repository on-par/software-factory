import { detectClaudePlan, type ClaudeLoginEvidenceDeps, type ProviderPlan } from './claude-config.js';
import { codexHasApiKey, hasCodexLoginEvidence, type CodexLoginEvidenceDeps } from './codex-config.js';

export { detectClaudePlan, codexHasApiKey };
export type { ProviderPlan };

export type ProviderPlanDeps = ClaudeLoginEvidenceDeps & CodexLoginEvidenceDeps;

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

export interface ProviderPlanModel {
  harness?: string;
  providerModel?: string;
  endpoint?: string;
}

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
    if (harness === 'copilot-cli') return 'subscription';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

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
