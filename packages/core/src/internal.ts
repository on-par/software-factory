// packages/core/src/internal.ts — Implementation details consumed by the factory's
// own packages (cli, tui, root scripts). No stability guarantee: these exports may
// change or disappear without notice. See ADR-0004 for the public/internal split.

// Concrete coding harnesses
export { classifyFailure } from './harness/classify.js';
export type { ClaudeExecFn } from './harness/claude-cli.js';
export { ClaudeCliHarness } from './harness/claude-cli.js';
export type { CodexExecFn } from './harness/codex-cli.js';
export { CodexCliHarness } from './harness/codex-cli.js';
export { isAgenticHarness, isRetryableFailure, NON_RETRYABLE_FAILURE_REASONS } from './harness/index.js';
export type { OllamaAgenticChange, OllamaAgenticExecFn, OllamaAgenticProposal } from './harness/ollama-agentic.js';
export { OllamaAgenticHarness, PATCH_PROPOSAL_SCHEMA } from './harness/ollama-agentic.js';
export type { OllamaFetchFn } from './harness/ollama-http.js';
export { OllamaHttpHarness } from './harness/ollama-http.js';
export type { OpenCodeExecFn } from './harness/opencode.js';
export { OpenCodeHarness } from './harness/opencode.js';

// Router
export { CliModelExecutor } from './router/index.js';

// Phase helpers
export { disputeResolution } from './phases/check.js';
export type { PlanPromptOpts } from './phases/plan.js';
export { buildPlanPrompt } from './phases/plan.js';

// Local-small harness
export type {
  OvernightItemOutcome,
  OvernightItemStatus,
  OvernightPreflightResult,
  OvernightQueueDeps,
  OvernightQueueInput,
  OvernightQueueResult,
  OvernightQueueState,
  OvernightStateItem,
} from './local-small/overnight.js';
export { runOvernightQueue } from './local-small/overnight.js';
export type {
  LocalSmallContextPack,
  LocalSmallDryRunInput,
  LocalSmallDryRunResult,
  LocalSmallLimits,
  LocalSmallPatchChange,
  LocalSmallPatchProposal,
  LocalSmallPatchStepInput,
  LocalSmallPatchStepResult,
  LocalSmallPatchStepStatus,
  LocalSmallStep,
  LocalSmallStepPlan,
} from './local-small/stepwise.js';
export { applyLocalSmallPatchStep, createLocalSmallDryRun } from './local-small/stepwise.js';

// Eval internals
export { judgeSpec, median, runJudgeSamples, scoreSpec } from './eval/index.js';

// Usage internals
export { defaultTranscriptRoots, priceFor, TRAILING_WINDOW_MS } from './usage/index.js';
export { readClaudeAccessToken } from './usage/subscription.js';

// Utils
export type { CiOutcome, WatchChecksOptions } from './utils/ci-watch.js';
export { watchChecks } from './utils/ci-watch.js';
export type { CommandResult, RunCommandOptions } from './utils/command-runner.js';
export { describeCommandFailure, runCommand } from './utils/command-runner.js';
export type { CoverageMetrics, RatchetCheckResult, RatchetDrift } from './utils/coverage-ratchet.js';
export {
  checkRatchetDrift,
  checkScopedRatchetDrift,
  DEFAULT_RATCHET_SLACK,
  parseCoverageSummary,
  parseCoverageSummaryScopes,
  renderRatchetReport,
} from './utils/coverage-ratchet.js';
export {
  branchFor,
  branchPrefixSlug,
  cleanupWorktree,
  codexDisabled,
  colorEnabled,
  ensureDir,
  escalationLine,
  formatEventLine,
  gitFetch,
  isEscalation,
  levelForType,
  logCost,
  logEvent,
  readCosts,
  setupWorktree,
  shellEscape,
  slugify,
} from './utils/index.js';
export type { FileLockOptions } from './utils/lock.js';
export { withFileLock, withGitLock } from './utils/lock.js';
export type { GcCandidate, GcReason, GcReport, SweepDeps, WorktreeListEntry } from './utils/worktree-gc.js';
export {
  findCredentialFiles,
  formatGcReport,
  parseWorktreeList,
  scrubFile,
  sweepWorktrees,
  zeroFill,
} from './utils/worktree-gc.js';
