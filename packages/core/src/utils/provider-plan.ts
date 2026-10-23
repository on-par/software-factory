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
