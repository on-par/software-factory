// src/harness/index.ts — CodingHarness contract: the common target every
// provider adapter (Claude CLI, Codex CLI, Ollama, OpenCode, Pi) must satisfy.

import type { ModelRegistry } from '../models/index.js';
import type { SandboxPolicy } from '../sandbox/index.js';
import type { FailoverReason, TaskType } from '../types/index.js';

/** Router's FailoverReason is a type alias of HarnessFailureReason (see
 *  ../router/index.ts) so the two unions can never drift. */
/** Tasks that edit files in a worktree and therefore require an agentic harness. */
export const AGENTIC_BUILD_TASKS = ['build_codex', 'build_claude'] as const satisfies readonly TaskType[];

/** Single source of truth for whether a task requires a file-editing (agentic) harness. */
export function taskRequiresAgenticHarness(task: TaskType): boolean {
  return (AGENTIC_BUILD_TASKS as readonly string[]).includes(task);
}

export type HarnessFailureReason = FailoverReason;

/** Deterministic failures: another model cannot plausibly help, so the
 *  router must not fail over to the next tier. */
export const NON_RETRYABLE_FAILURE_REASONS = [
  'schema_invalid',
  'apply_failed',
  'verify_failed',
] as const satisfies readonly HarnessFailureReason[];

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
  /** When set, the harness wraps its CLI invocation in this containment policy. */
  sandbox?: SandboxPolicy;
  /** Extra child-env vars (e.g. the lane's PORT lease) merged over the parent env. */
  env?: Record<string, string>;
  /** When set, the harness's exec child is spawned detached (its own
   *  process group) and its pid reported here so the lane can track and
   *  later kill the whole group. */
  onPgid?: (pgid: number) => void;
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
    readonly details: {
      exitCode?: number;
      stderr?: string;
      stdout?: string;
      code?: string | number;
      signal?: string;
      killed?: boolean;
    } = {},
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
 * - Callers (executors) must propagate the 'empty_response' rejection —
 *   resolving an empty string in place of it violates this contract.
 */
export interface CodingHarness {
  /** Stable identifier, e.g. 'stub', 'claude-cli', 'codex-cli', 'ollama-http'. */
  readonly id: string;
  /** True when the harness can edit files in the worktree (build routes
   *  require this); false for prompt-only harnesses like Ollama HTTP. */
  readonly agentic: boolean;
  run(request: HarnessRequest): Promise<HarnessResult>;
}

export type { HarnessCatalogEntry, HarnessProbe } from './catalog.js';
export { HARNESS_CATALOG, isAgenticHarness, KNOWN_HARNESS_IDS } from './catalog.js';
