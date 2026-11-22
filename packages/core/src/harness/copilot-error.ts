import { classifyFailure } from './classify.js';
import type { HarnessFailureReason } from './index.js';
import { failureKindFor, type ProviderFailure, type ProviderFailureKind } from './provider-failure.js';

const DETAIL_LIMIT = 400;

export const COPILOT_CONTAINMENT_HINT =
  'no OS sandbox contains this run, so --allow-all was not passed and nothing can approve the tool call; run where sandbox-exec or firejail is available, or set sandbox.copilotAllowAll: true only inside an isolated runtime';

const TOKEN_REJECTED = 'the Copilot token was rejected';
const NO_CREDENTIAL = 'no Copilot credential: set COPILOT_GITHUB_TOKEN or run `copilot login`';
const ALLOWANCE_USED = 'the Copilot premium request allowance is used up';

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
    cause: TOKEN_REJECTED,
  },
  {
    pattern: /no authentication information found/i,
    reason: 'local_auth',
    cause: NO_CREDENTIAL,
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
    cause: ALLOWANCE_USED,
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

function field(data: Record<string, unknown>, key: string): string {
  const value = data[key];
  return typeof value === 'string' ? value : '';
}

export function classifyCopilotSessionError(data: Record<string, unknown>): CopilotFailure | undefined {
  const errorType = field(data, 'errorType');
  const errorCode = field(data, 'errorCode');
  const status = typeof data.statusCode === 'number' ? data.statusCode : undefined;
  const detail = field(data, 'message').trim().slice(0, DETAIL_LIMIT);
  if (errorCode === 'no_account') {
    return { reason: 'local_auth', kind: failureKindFor('local_auth', detail), detail, cause: NO_CREDENTIAL };
  }
  if (errorType === 'authentication') return { reason: 'local_auth', kind: 'auth', detail, cause: TOKEN_REJECTED };
  if (errorType === 'quota' || status === 402) {
    return { reason: 'usage_cap', kind: 'usage_cap', detail, cause: ALLOWANCE_USED };
  }
  if (errorType === 'rate_limit' || status === 429 || errorCode.endsWith('rate_limited')) {
    return { reason: 'rate_limit', kind: 'rate_limit', detail };
  }
  return undefined;
}
