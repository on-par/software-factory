// src/harness/index.ts — CodingHarness contract: the common target every
// provider adapter (Claude CLI, Codex CLI, Ollama, OpenCode, Pi) must satisfy.

import type { TaskType } from '../types/index.js';
import type { ModelRegistry } from '../models/index.js';

/** Router's FailoverReason is a type alias of HarnessFailureReason (see
 *  ../router/index.ts) so the two unions can never drift. */
/** Tasks that edit files in a worktree and therefore require an agentic harness. */
export const AGENTIC_BUILD_TASKS = ['build_codex', 'build_claude'] as const satisfies readonly TaskType[];

/** Single source of truth for whether a task requires a file-editing (agentic) harness. */
export function taskRequiresAgenticHarness(task: TaskType): boolean {
  return (AGENTIC_BUILD_TASKS as readonly string[]).includes(task);
}

export type HarnessFailureReason =
  | 'rate_limit'
  | 'usage_cap'
  | 'timeout'
  | 'error'
  | 'empty_response'
  | 'schema_invalid'   // model output failed deterministic schema validation
  | 'apply_failed'     // patch could not be applied to the worktree
  | 'verify_failed'    // deterministic verify/build command failed in the environment
  | 'unknown';

/** Deterministic failures: another model cannot plausibly help, so the
 *  router must not fail over to the next tier. */
export const NON_RETRYABLE_FAILURE_REASONS = ['schema_invalid', 'apply_failed', 'verify_failed'] as const satisfies readonly HarnessFailureReason[];

/** True when failing over to another model can plausibly help. */
export function isRetryableFailure(reason: HarnessFailureReason): boolean {
  return !(NON_RETRYABLE_FAILURE_REASONS as readonly string[]).includes(reason);
}

export interface HarnessRequest {
  /** Registry model id (key in models.json), not the provider-native id. */
  model: string;
  prompt: string;
  /** Absolute path to the worktree the harness may operate in. */
  worktree: string;
  timeoutSeconds: number;
  task: TaskType;
  /** For resolving provider flags/ids (claudeFlag, codexFlag, providerModel). */
  registry: ModelRegistry;
}

export interface HarnessResult {
  /** Always non-empty after trim — empty provider output must throw instead. */
  output: string;
}

/** Every harness failure must be thrown as a HarnessError so callers can
 *  read a classified `reason` (the router failover reads `err.reason`). */
export class HarnessError extends Error {
  constructor(
    message: string,
    readonly reason: HarnessFailureReason,
    readonly details: { exitCode?: number; stderr?: string; code?: string | number; signal?: string; killed?: boolean } = {},
  ) {
    super(message);
    this.name = 'HarnessError';
  }
}

/**
 * Contract (verified by ../harness/contract.ts):
 * - run() resolves only with non-empty (trimmed) output.
 * - Empty provider output rejects with HarnessError reason 'empty_response'.
 * - Timeouts reject with HarnessError reason 'timeout'.
 * - Nonzero exits / provider errors reject with a classified HarnessFailureReason.
 */
export interface CodingHarness {
  /** Stable identifier, e.g. 'stub', 'claude-cli', 'codex-cli', 'ollama-http'. */
  readonly id: string;
  /** True when the harness can edit files in the worktree (build routes
   *  require this); false for prompt-only harnesses like Ollama HTTP. */
  readonly agentic: boolean;
  run(request: HarnessRequest): Promise<HarnessResult>;
}

export { HARNESS_CATALOG, KNOWN_HARNESS_IDS, isAgenticHarness } from './catalog.js';
export type { HarnessCatalogEntry, HarnessProbe } from './catalog.js';
