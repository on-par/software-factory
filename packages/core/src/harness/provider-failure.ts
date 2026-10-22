// src/harness/provider-failure.ts — provider-agnostic failure shape (#3225).
// Harness adapters put `kind`/`resetAt` on HarnessError.details at throw time; the router reads them back here.

import { ModelExecutorError } from '../router/executor-error.js';
import { describeFailureDetail } from '../router/failure-detail.js';
import { classifyFailure, isRejectedCredential } from './classify.js';
import type { HarnessFailureReason } from './index.js';
import { HarnessError } from './index.js';

export const PROVIDER_FAILURE_KINDS = ['usage_cap', 'rate_limit', 'auth', 'unavailable', 'other'] as const;
export type ProviderFailureKind = (typeof PROVIDER_FAILURE_KINDS)[number];

/** One classified provider failure. `reason` stays the fine-grained label for logs and telemetry. */
export interface ProviderFailure {
  kind: ProviderFailureKind;
  /** ISO instant at which the provider says it works again, when it said so. */
  resetAt?: string;
  reason: HarnessFailureReason;
  detail: string;
}

// Exhaustive so a new FailoverReason fails typecheck until it is mapped.
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

/** One-way map from the 13 failure reasons onto the five kinds. */
export function failureKindForReason(reason: HarnessFailureReason): ProviderFailureKind {
  return KIND_BY_REASON[reason];
}

function isProviderFailureKind(value: unknown): value is ProviderFailureKind {
  return typeof value === 'string' && (PROVIDER_FAILURE_KINDS as readonly string[]).includes(value);
}

/** Normalized ISO string when `value` is a parseable instant, else undefined. */
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

/** Classifier for harnesses without their own `classifyError`: the typed reason (or classifyFailure on
 *  stderr/exit code) mapped to a kind, plus any kind/resetAt the adapter left on `details`. */
export function defaultClassifyError(err: unknown): ProviderFailure {
  const detail = describeFailureDetail(err);
  if (err instanceof HarnessError || err instanceof ModelExecutorError) {
    const details = detailsOf(err);
    const resetAt = normalizeIsoInstant(details.resetAt);
    const text = [err.message, details.stderr, details.diagnostic, detail]
      .filter((t) => typeof t === 'string')
      .join('\n');
    const rejected = err.reason === 'local_auth' && isRejectedCredential(text);
    return {
      kind: isProviderFailureKind(details.kind) ? details.kind : rejected ? 'auth' : failureKindForReason(err.reason),
      ...(resetAt ? { resetAt } : {}),
      reason: err.reason,
      detail,
    };
  }
  const reason = classifyFailure(stderrOf(err), exitCodeOf(err));
  const rejected = reason === 'local_auth' && isRejectedCredential(stderrOf(err));
  return { kind: rejected ? 'auth' : failureKindForReason(reason), reason, detail };
}

/** What the router calls for a thrown error. Adapters have already put kind/resetAt on `details`. */
export function providerFailureOf(err: unknown): ProviderFailure {
  return defaultClassifyError(err);
}
