import type { CodexSandboxMode } from '../config/sandbox-schema.js';
import type { ModelRegistry } from '../models/index.js';
import type { SandboxPolicy } from '../sandbox/index.js';
import type { FailoverReason, TaskType } from '../types/index.js';
import type { AgentEvent } from './agent-events.js';
import type { ProviderFailure, ProviderFailureKind } from './provider-failure.js';

export const AGENTIC_BUILD_TASKS = [
  'build_codex',
  'build_claude',
  'build_opencode',
  'build_command',
] as const satisfies readonly TaskType[];

export function taskRequiresAgenticHarness(task: TaskType): boolean {
  return (AGENTIC_BUILD_TASKS as readonly string[]).includes(task);
}

export type HarnessFailureReason = FailoverReason;

export const NON_RETRYABLE_FAILURE_REASONS = [
  'schema_invalid',
  'apply_failed',
  'verify_failed',
  'permission_denied',
] as const satisfies readonly HarnessFailureReason[];

export function isRetryableFailure(reason: HarnessFailureReason): boolean {
  return !(NON_RETRYABLE_FAILURE_REASONS as readonly string[]).includes(reason);
}

export interface HarnessRequest {
  model: string;
  prompt: string;
  worktree: string;
  timeoutSeconds: number;
  task: TaskType;
  registry: ModelRegistry;
  sandbox?: SandboxPolicy;
  writableRoots?: readonly string[];
  primaryRepoRoot?: string;
  codexFullAccessTasks?: readonly string[];
  codexSandbox?: CodexSandboxMode;
  env?: Record<string, string>;
  onPgid?: (pgid: number) => void;
  onEvent?: (event: AgentEvent) => void;
  onUsage?: (cumulative: HarnessLiveUsage) => void;
  contextCeiling?: number;
}

export interface HarnessUsage {
  inputTokens: number;
  outputTokens: number;
  rawInputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  numTurns?: number;
  peakInputTokens?: number;
  contextWindow?: number;
  durationMs?: number;
  durationApiMs?: number;
  costUsd?: number;
}

export type HarnessLiveUsage = HarnessUsage & { calls: number };

export interface HarnessResult {
  output: string;
  usage?: HarnessUsage;
}

export class HarnessError extends Error {
  constructor(
    message: string,
    readonly reason: HarnessFailureReason,
    readonly details: {
      exitCode?: number;
      stderr?: string;
      stdout?: string;
      diagnostic?: string;
      code?: string | number;
      signal?: string;
      killed?: boolean;
      stalled?: boolean;
      tracePath?: string;
      kind?: ProviderFailureKind;
      resetAt?: string;
    } = {},
  ) {
    super(message);
    this.name = 'HarnessError';
  }
}

export interface CodingHarness {
  readonly id: string;
  readonly agentic: boolean;
  run(request: HarnessRequest): Promise<HarnessResult>;
  classifyError?(err: unknown): ProviderFailure;
}

export type { ProviderFailure, ProviderFailureKind } from './provider-failure.js';

export type { HarnessCatalogEntry } from './catalog.js';
export { HARNESS_CATALOG, KNOWN_HARNESS_IDS } from './catalog.js';
