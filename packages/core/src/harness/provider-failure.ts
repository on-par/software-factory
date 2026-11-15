import { ModelExecutorError } from '../router/executor-error.js';
import { describeFailureDetail } from '../router/failure-detail.js';
import { classifyFailure, isRejectedCredentialText } from './classify.js';
import type { HarnessFailureReason } from './index.js';
import { HarnessError } from './index.js';

export const PROVIDER_FAILURE_KINDS = ['usage_cap', 'rate_limit', 'auth', 'unavailable', 'other'] as const;
export type ProviderFailureKind = (typeof PROVIDER_FAILURE_KINDS)[number];

export interface ProviderFailure {
  kind: ProviderFailureKind;
  resetAt?: string;
  reason: HarnessFailureReason;
  detail: string;
}

const KIND_BY_REASON: Record<HarnessFailureReason, ProviderFailureKind> = {
  usage_cap: 'usage_cap',
  rate_limit: 'rate_limit',
  schema_invalid: 'other',
  apply_failed: 'other',
  verify_failed: 'other',
  permission_denied: 'other',
  timeout: 'unavailable',
  unavailable: 'unavailable',
  empty_response: 'unavailable',
  cli_missing: 'unavailable',
  error: 'unavailable',
  unknown: 'unavailable',
  local_auth: 'unavailable',
};

export function failureKindForReason(reason: HarnessFailureReason): ProviderFailureKind {
  return KIND_BY_REASON[reason];
}

export function failureKindFor(reason: HarnessFailureReason, text: string): ProviderFailureKind {
  return reason === 'local_auth' && isRejectedCredentialText(text) ? 'auth' : failureKindForReason(reason);
}

function isProviderFailureKind(value: unknown): value is ProviderFailureKind {
  return typeof value === 'string' && (PROVIDER_FAILURE_KINDS as readonly string[]).includes(value);
}

export function normalizeIsoInstant(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function detailsOf(err: unknown): Record<string, unknown> {
  const details = (err as { details?: unknown } | null)?.details;
  return typeof details === 'object' && details !== null ? (details as Record<string, unknown>) : {};
}

function stderrOf(err: unknown): string {
  const stderr = (err as { stderr?: unknown } | null)?.stderr;
  return typeof stderr === 'string' ? stderr : '';
}

function exitCodeOf(err: unknown): number {
  const exitCode = (err as { exitCode?: unknown } | null)?.exitCode;
  return typeof exitCode === 'number' ? exitCode : 1;
}

export function defaultClassifyError(err: unknown): ProviderFailure {
  const detail = describeFailureDetail(err);
  if (err instanceof HarnessError || err instanceof ModelExecutorError) {
    const details = detailsOf(err);
    const resetAt = normalizeIsoInstant(details.resetAt);
    return {
      kind: isProviderFailureKind(details.kind) ? details.kind : failureKindFor(err.reason, detail),
      ...(resetAt ? { resetAt } : {}),
      reason: err.reason,
      detail,
    };
  }
  const reason = classifyFailure(stderrOf(err), exitCodeOf(err));
  return { kind: failureKindFor(reason, stderrOf(err)), reason, detail };
}

export function providerFailureOf(err: unknown): ProviderFailure {
  return defaultClassifyError(err);
}
