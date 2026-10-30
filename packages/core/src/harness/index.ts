// src/harness/index.ts — CodingHarness contract: the common target every
// provider adapter (Claude CLI, Codex CLI, Ollama, OpenCode, Pi) must satisfy.

import type { CodexSandboxMode } from '../config/sandbox-schema.js';
import type { ModelRegistry } from '../models/index.js';
import type { SandboxPolicy } from '../sandbox/index.js';
import type { FailoverReason, TaskType } from '../types/index.js';
import type { ProviderFailure, ProviderFailureKind } from './provider-failure.js';

/** Router's FailoverReason is a type alias of HarnessFailureReason (see
 *  ../router/index.ts) so the two unions can never drift. */
/** Tasks that edit files in a worktree and therefore require an agentic harness. */
export const AGENTIC_BUILD_TASKS = [
  'build_codex',
  'build_claude',
  'build_opencode',
  'build_command',
] as const satisfies readonly TaskType[];

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
  'permission_denied',
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
  /** Factory-owned paths outside the worktree that this task may write. */
  writableRoots?: readonly string[];
  /** Primary checkout root, used to reject a writable root that grants the whole checkout. */
  primaryRepoRoot?: string;
  /** Configured Codex task names allowed danger-full-access, independent of OS sandbox policy. */
  codexFullAccessTasks?: readonly string[];
  /** Configured Codex sandbox mode (sandbox.codexSandbox, #3830); undefined = today's behavior. Not read by the harness yet (#3824). */
  codexSandbox?: CodexSandboxMode;
  /** Extra child-env vars (e.g. the lane's PORT lease) merged over the parent env. */
  env?: Record<string, string>;
  /** When set, the harness's exec child is spawned detached (its own
   *  process group) and its pid reported here so the lane can track and
   *  later kill the whole group. */
  onPgid?: (pgid: number) => void;
  /** When set, the harness reports cumulative usage while the session runs (Codex only for now). */
  onUsage?: (cumulative: HarnessLiveUsage) => void;
  /** Codex auto-compact token limit for agentic build tasks; default 120000, 0 turns it off (#3326). */
  contextCeiling?: number;
}

/** Provider-reported token usage for one harness invocation (#424). */
export interface HarnessUsage {
  /** All input-side tokens: input_tokens + cache_creation_input_tokens + cache_read_input_tokens. */
  inputTokens: number;
  outputTokens: number;
  /** Uncached input tokens (the envelope's raw input_tokens), when reported (#490). */
  rawInputTokens?: number;
  /** Cache split, when the provider reports it (#490). */
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  /** Model-call count for Codex or envelope turn count for other harnesses. */
  numTurns?: number;
  /** Maximum input token count from one model call. */
  peakInputTokens?: number;
  /** Reported token capacity for the model context. */
  contextWindow?: number;
  /** Wall-clock and API-time durations from the CLI result envelope, in ms (#490). */
  durationMs?: number;
  durationApiMs?: number;
  /** Provider-reported total cost in USD, when the CLI reports one. */
  costUsd?: number;
}

/** Cumulative usage reported while a session is still running (#3319). */
export type HarnessLiveUsage = HarnessUsage & { calls: number };

export interface HarnessResult {
  /** Always non-empty after trim — empty provider output must throw instead. */
  output: string;
  /** Real provider-reported usage, when the harness can parse it (#424). */
  usage?: HarnessUsage;
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
      /** The exact text the classifier keyed on, when narrower than raw stdout/stderr (#1520). */
      diagnostic?: string;
      code?: string | number;
      signal?: string;
      killed?: boolean;
      /** True when the stall watch killed an idle child before the phase timeout (#694). */
      stalled?: boolean;
      /** JSON file holding the raw (capped) output of each attempt of an empty run (#694). */
      tracePath?: string;
      /** Provider-agnostic failure kind set by the adapter (#3225). */
      kind?: ProviderFailureKind;
      /** ISO instant at which the provider says it recovers, when it reported one (#3225). */
      resetAt?: string;
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
  /** Classifies a failure this harness threw into the provider-agnostic shape. Harnesses without one get
   *  `defaultClassifyError` (reason from the error, kind by the reason map). */
  classifyError?(err: unknown): ProviderFailure;
}

export type { ProviderFailure, ProviderFailureKind } from './provider-failure.js';

export type { HarnessCatalogEntry } from './catalog.js';
export { HARNESS_CATALOG, KNOWN_HARNESS_IDS } from './catalog.js';
