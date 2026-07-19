// packages/core/src/index.ts — Library entry point for programmatic use
//
// This is the narrow public API of @on-par/factory-core (ADR-0004). Implementation
// details live behind '@on-par/factory-core/internal'; test doubles and contract
// kits live behind '@on-par/factory-core/testing'.

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
export { failoversFrom, ModelRouter } from './router/index.js';

// Coding harness contract
export type {
  CodingHarness,
  HarnessCatalogEntry,
  HarnessFailureReason,
  HarnessRequest,
  HarnessResult,
} from './harness/index.js';
export { HARNESS_CATALOG, HarnessError, KNOWN_HARNESS_IDS } from './harness/index.js';

// Constitutions
export { buildConstitutionContext, ConstitutionLoader, REPO_INSTRUCTION_FILES } from './constitutions/index.js';

// Sandbox
export type { SandboxEventType, SandboxPolicy, SandboxRuntime } from './sandbox/index.js';
export { detectSandboxRuntime, resolveSandboxPolicy } from './sandbox/index.js';

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
export { checkPhase } from './phases/check.js';
export { planPhase } from './phases/plan.js';
export { shipPhase } from './phases/ship.js';

// Approvals
export type { ApprovalGate, ApprovalRequest, ApprovalResponse, FileApprovalGateOptions } from './approvals/index.js';
export { createFileApprovalGate, listPendingApprovals, respondToApproval } from './approvals/index.js';

// Reports
export type { LocalRunOutcome, LocalRunReport, LocalRunReportDeps, LocalRunReportInput } from './reports/local-run.js';
export { renderLocalRunReport, writeLocalRunReport } from './reports/local-run.js';

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
  loadGoldenCases,
  parseHistory,
  REGRESSION_ISSUE_MARKER,
  REGRESSION_ISSUE_TITLE,
  renderLocalSmallScoreboardMarkdown,
  renderTrend,
  runEval,
  summaryToHistoryRecord,
  toBaseline,
} from './eval/index.js';

// Logger
export type { FactoryLogger, LogContext, LogExtra, LoggerOptions } from './logger/index.js';
export { createLogger } from './logger/index.js';
export type { LogLevel } from './types/index.js';

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
  estimateTrailingSpend,
  formatUsageReport,
  readCostsFile,
  readUsage,
  watchUsage,
} from './usage/index.js';
export type { SubscriptionUsage, SubscriptionUsageDeps } from './usage/subscription.js';
export { fetchSubscriptionUsage } from './usage/subscription.js';

// Types
export type * from './types/index.js';
