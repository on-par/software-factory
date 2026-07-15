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

/** Type-safe read of a failover reason: only typed failures
 *  (ModelExecutorError, HarnessError) carry one. Anything else returns
 *  undefined so the caller falls back to stderr/exit-code classification. */
export function extractFailoverReason(err: unknown): HarnessFailureReason | undefined {
  if (err instanceof ModelExecutorError) return err.reason;
  if (err instanceof HarnessError) return err.reason;
  return undefined;
}
