import { classifyFailure } from './classify.js';
import type { HarnessFailureReason } from './index.js';
import { failureKindFor, type ProviderFailure, type ProviderFailureKind } from './provider-failure.js';

const DETAIL_LIMIT = 400;

export const COPILOT_CONTAINMENT_HINT =
  'no OS sandbox contains this run, so --allow-all was not passed and nothing can approve the tool call; run where sandbox-exec or firejail is available, or set sandbox.copilotAllowAll: true only inside an isolated runtime';

interface CopilotPattern {
  pattern: RegExp;
  reason: HarnessFailureReason;
  kind?: ProviderFailureKind;
  cause: string;
}

const COPILOT_PATTERNS: readonly CopilotPattern[] = [
  {
    pattern: /classic personal access tokens \(ghp_\) are not supported/i,
    reason: 'local_auth',
    kind: 'auth',
    cause:
      'classic tokens (ghp_) are not supported; use a fine-grained github_pat_ token with the Copilot Requests permission',
  },
  {
    pattern: /access denied by policy settings/i,
    reason: 'local_auth',
    kind: 'auth',
    cause: 'no Copilot plan, or the organization does not allow Copilot CLI',
  },
  {
    pattern: /authentication failed|token may be invalid, expired/i,
    reason: 'local_auth',
    kind: 'auth',
    cause: 'the Copilot token was rejected',
  },
  {
    pattern: /no authentication information found/i,
    reason: 'local_auth',
    cause: 'no Copilot credential: set COPILOT_GITHUB_TOKEN or run `copilot login`',
  },
  {
    pattern: /permission denied and could not request permission/i,
    reason: 'permission_denied',
    cause: COPILOT_CONTAINMENT_HINT,
  },
  {
    pattern: /quota exceeded|premium requests? (?:allowance |quota )?(?:exhausted|exceeded)/i,
    reason: 'usage_cap',
    kind: 'usage_cap',
    cause: 'the Copilot premium request allowance is used up',
  },
];

export interface CopilotFailure extends ProviderFailure {
  cause?: string;
}

export function classifyCopilotFailure(text: string, exitCode: number): CopilotFailure {
  const match = COPILOT_PATTERNS.find(({ pattern }) => pattern.test(text));
  const reason = match?.reason ?? classifyFailure(text, exitCode);
  const kind = match?.kind ?? failureKindFor(reason, text);
  return { kind, reason, detail: text.trim().slice(0, DETAIL_LIMIT), ...(match ? { cause: match.cause } : {}) };
}
