// src/harness/index.ts — CodingHarness contract: the common target every
// provider adapter (Claude CLI, Codex CLI, Ollama, OpenCode, Pi) must satisfy.

import type { TaskType } from '../types/index.js';
import type { ModelRegistry } from '../models/index.js';

/** Mirrors router FailoverReason. Defined here (not imported from ../router)
 *  so extracting harnesses out of the router later cannot create an import
 *  cycle; the unions must stay value-identical. */
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
  | 'unknown';

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
export type { HarnessCatalogEntry } from './catalog.js';
