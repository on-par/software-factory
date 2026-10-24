// src/router/executor-error.ts — typed executor failure + type-safe reason extraction.
// No imports from ./index.js to avoid cycles.

import { HarnessError, type HarnessFailureReason } from '../harness/index.js';

/** Typed failure thrown by ModelExecutor implementations. `reason` drives
 *  router failover; HarnessFailureReason is value-identical to the router's
 *  FailoverReason union. */
export class ModelExecutorError extends Error {
  constructor(
    message: string,
    readonly reason: HarnessFailureReason,
    readonly details: { exitCode?: number; stderr?: string; tracePath?: string } = {},
  ) {
    super(message);
    this.name = 'ModelExecutorError';
  }
}

/** A model attempt recorded by the router, whether it succeeded or failed. */
export interface RouterAttempt {
  model: string;
  reason: HarnessFailureReason | null;
  ok: boolean;
  detail?: string;
}

/** Why a ModelRouterError ended the run, beyond its reason: every remaining failover target was metered (#3234). */
export type RouterErrorDetail = 'only_metered_left';

/** Typed terminal failure thrown by ModelRouter after an exhausted or guarded-abort run. */
export class ModelRouterError extends Error {
  constructor(
    message: string,
    readonly reason: HarnessFailureReason,
    readonly attempts: RouterAttempt[],
    readonly detail?: RouterErrorDetail,
  ) {
    super(message);
    this.name = 'ModelRouterError';
  }
}

/** Read the router failure payload structurally so compatible cross-boundary
 *  errors remain useful without relying on a class identity. */
export function routerFailureOf(
  err: unknown,
): { reason: HarnessFailureReason; attempts: RouterAttempt[]; detail?: RouterErrorDetail } | undefined {
  if (
    typeof err !== 'object' ||
    err === null ||
    typeof (err as { reason?: unknown }).reason !== 'string' ||
    !Array.isArray((err as { attempts?: unknown }).attempts)
  ) {
    return undefined;
  }
  const failure = err as { reason: HarnessFailureReason; attempts: RouterAttempt[]; detail?: unknown };
  const base = { reason: failure.reason, attempts: failure.attempts };
  return typeof failure.detail === 'string' ? { ...base, detail: failure.detail as RouterErrorDetail } : base;
}

/** Type-safe read of a failover reason: only typed failures
 *  (ModelExecutorError, HarnessError) carry one. Anything else returns
 *  undefined so the caller falls back to stderr/exit-code classification. */
export function extractFailoverReason(err: unknown): HarnessFailureReason | undefined {
  if (err instanceof ModelExecutorError) return err.reason;
  if (err instanceof HarnessError) return err.reason;
  return undefined;
}
