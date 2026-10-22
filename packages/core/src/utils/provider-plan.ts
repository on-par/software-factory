// src/utils/provider-plan.ts — billing plan (flat-rate vs metered) per provider id, from auth alone (#3214).
//
// A leaf over the two provider config modules, for failover routing (#3234). Presence checks only:
// no credential value is read into the result, no command but the existing login probes runs.

import { detectClaudePlan, type ClaudeLoginEvidenceDeps, type ClaudePlan } from './claude-config.js';
import { codexHasApiKey, hasCodexLoginEvidence, type CodexLoginEvidenceDeps } from './codex-config.js';

export type ProviderPlanDeps = ClaudeLoginEvidenceDeps & CodexLoginEvidenceDeps;

/** Plan for a provider id: 'anthropic' follows Claude Code auth; 'openai'/'codex' is 'api' with an
 *  OpenAI API key, else 'subscription' with a Codex login; 'opencode-go/' is the flat Go
 *  subscription and 'opencode/' is pay-per-use Zen. Anything else is 'unknown'. Never throws. */
export function detectProviderPlan(id: string, deps: ProviderPlanDeps = {}): ClaudePlan {
  try {
    if (id === 'anthropic') return detectClaudePlan(deps);
    if (id === 'openai' || id === 'codex') {
      if (codexHasApiKey(deps)) return 'api';
      return hasCodexLoginEvidence(deps) ? 'subscription' : 'unknown';
    }
    if (id.startsWith('opencode-go/')) return 'subscription';
    if (id.startsWith('opencode/')) return 'api';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}
