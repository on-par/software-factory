// packages/core/src/index.ts — Library entry point for programmatic use

// Config
export type { FactoryConfig, ModelsConfig, RoutesConfig } from './config/index.js';
export {
  getConstitutionsDir,
  getFactoryPaths,
  loadFactoryConfig,
  loadModelsConfig,
  loadRoutesConfig,
  resolveSkipCI,
  resolveTimeouts,
} from './config/index.js';

// Queue
export type {
  ParsedQueue,
  QueueDiagnostic,
  QueueEntry,
  QueueSnapshot,
  QueueSnapshotEntry,
  QueueValidationResult,
} from './queue/index.js';
export { parseQueue, readQueue, validateQueue } from './queue/index.js';

// Events
export type { FollowEventsOptions } from './events/index.js';
export { followEvents, readEvents } from './events/index.js';

// Models
export type { DoctorProbes, ModelDiagnosis, ModelOverrides } from './models/index.js';
export { diagnoseModels, isCommandAvailable, ModelRegistry, resolveModelOverrides } from './models/index.js';

// Router
export type {
  ExecutorHarness,
  FailoverReason,
  ModelExecutor,
  ModelExecutorContext,
  RouterResult,
  SleepFn,
} from './router/index.js';
export { CliModelExecutor, failoversFrom, ModelRouter } from './router/index.js';
export type { StubModelExecutorOptions } from './router/stub.js';
export { StubModelExecutor } from './router/stub.js';

// Coding harness contract
export { classifyFailure } from './harness/classify.js';
export type { ClaudeExecFn } from './harness/claude-cli.js';
export { ClaudeCliHarness } from './harness/claude-cli.js';
export type { CodexExecFn } from './harness/codex-cli.js';
export { CodexCliHarness } from './harness/codex-cli.js';
export type { HarnessContractCase, HarnessContractScenario, HarnessContractScenarios } from './harness/contract.js';
export { codingHarnessContractCases, makeContractRequest } from './harness/contract.js';
export type {
  CodingHarness,
  HarnessCatalogEntry,
  HarnessFailureReason,
  HarnessRequest,
  HarnessResult,
} from './harness/index.js';
export {
  HARNESS_CATALOG,
  HarnessError,
  isAgenticHarness,
  isRetryableFailure,
  KNOWN_HARNESS_IDS,
  NON_RETRYABLE_FAILURE_REASONS,
} from './harness/index.js';
export type { OllamaAgenticChange, OllamaAgenticExecFn, OllamaAgenticProposal } from './harness/ollama-agentic.js';
export { OllamaAgenticHarness, PATCH_PROPOSAL_SCHEMA } from './harness/ollama-agentic.js';
export type { OllamaFetchFn } from './harness/ollama-http.js';
export { OllamaHttpHarness } from './harness/ollama-http.js';
export type { OpenCodeExecFn } from './harness/opencode.js';
export { OpenCodeHarness } from './harness/opencode.js';
export type { StubCodingHarnessOptions, StubHarnessStep } from './harness/stub.js';
export { StubCodingHarness } from './harness/stub.js';

// Constitutions
export { buildConstitutionContext, ConstitutionLoader, REPO_INSTRUCTION_FILES } from './constitutions/index.js';

// Checkers
export type { CheckerContext } from './checkers/index.js';
export {
  accessibilityChecker,
  compileChecker,
  linksChecker,
  lintChecker,
  runAllCheckers,
  runCustomChecker,
  testsChecker,
} from './checkers/index.js';
export type { CheckerOutput, CheckSummary } from './types/index.js';

// Phases
export { buildPhase } from './phases/build.js';
export { checkPhase, disputeResolution } from './phases/check.js';
export type { PlanPromptOpts } from './phases/plan.js';
export { buildPlanPrompt, planPhase } from './phases/plan.js';
export { shipPhase } from './phases/ship.js';

// Approvals
export type { ApprovalGate, ApprovalRequest, ApprovalResponse, FileApprovalGateOptions } from './approvals/index.js';
export { createFileApprovalGate, listPendingApprovals, respondToApproval } from './approvals/index.js';

// Reports
export type { LocalRunOutcome, LocalRunReport, LocalRunReportDeps, LocalRunReportInput } from './reports/local-run.js';
export { renderLocalRunReport, writeLocalRunReport } from './reports/local-run.js';

// Local-small harness
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

// Eval
export type {
  Baseline,
  BaselineCase,
  BaselineComparison,
  CaseResult,
  DeterministicCheck,
  EvalSummary,
  ExpectedRoute,
  GoldenCase,
  HistoryRecord,
  JudgeAggregate,
  JudgeSample,
  LocalSmallRuntime,
  LocalSmallScoreboardInput,
  LocalSmallScoreboardReport,
  LocalSmallScoreboardRow,
  LocalSmallScoreboardRun,
  RegressionIssue,
  RunEvalOpts,
} from './eval/index.js';
export {
  appendHistoryLine,
  buildLocalSmallScoreboard,
  compareToBaseline,
  formatRegressionIssue,
  isRouteAsserted,
  judgeSpec,
  loadGoldenCases,
  median,
  parseHistory,
  REGRESSION_ISSUE_MARKER,
  REGRESSION_ISSUE_TITLE,
  renderLocalSmallScoreboardMarkdown,
  renderTrend,
  runEval,
  runJudgeSamples,
  scoreSpec,
  summaryToHistoryRecord,
  toBaseline,
} from './eval/index.js';

// Utils
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

// Logger
export type { FactoryLogger, LogContext, LogExtra, LoggerOptions } from './logger/index.js';
export { createLogger } from './logger/index.js';
export type { LogLevel } from './types/index.js';
export type { CiOutcome, WatchChecksOptions } from './utils/ci-watch.js';
export { watchChecks } from './utils/ci-watch.js';
export type { CommandResult, RunCommandOptions } from './utils/command-runner.js';
export { describeCommandFailure, runCommand } from './utils/command-runner.js';
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

// Coverage ratchet
export type { CoverageMetrics, RatchetCheckResult, RatchetDrift } from './utils/coverage-ratchet.js';
export {
  checkRatchetDrift,
  checkScopedRatchetDrift,
  DEFAULT_RATCHET_SLACK,
  parseCoverageSummary,
  parseCoverageSummaryScopes,
  renderRatchetReport,
} from './utils/coverage-ratchet.js';

// Usage
export type {
  CostsRead,
  CostsSummary,
  IssueCostRow,
  ModelCostRow,
  ReadUsageOptions,
  TrailingUsageOptions,
  UsageReading,
  UsageSource,
  WatchUsageOptions,
} from './usage/index.js';
export {
  aggregateCosts,
  defaultTranscriptRoots,
  estimateTrailingSpend,
  formatUsageReport,
  priceFor,
  readCostsFile,
  readUsage,
  TRAILING_WINDOW_MS,
  watchUsage,
} from './usage/index.js';
export type { SubscriptionUsage, SubscriptionUsageDeps } from './usage/subscription.js';
export { fetchSubscriptionUsage, readClaudeAccessToken } from './usage/subscription.js';

// Types
export * from './types/index.js';
