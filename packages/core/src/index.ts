// packages/core/src/index.ts — Library entry point for programmatic use

// Config
export { loadModelsConfig, loadRoutesConfig, loadFactoryConfig, resolveTimeouts, resolveSkipCI, getFactoryPaths, getConstitutionsDir } from './config/index.js';
export type { ModelsConfig, RoutesConfig, FactoryConfig } from './config/index.js';

// Models
export { ModelRegistry, isCommandAvailable, diagnoseModels } from './models/index.js';
export type { DoctorProbes, ModelDiagnosis } from './models/index.js';

// Router
export { ModelRouter, CliModelExecutor } from './router/index.js';
export type { RouterResult, FailoverReason, ModelExecutor, ModelExecutorContext } from './router/index.js';
export { StubModelExecutor } from './router/stub.js';
export type { StubModelExecutorOptions } from './router/stub.js';

// Constitutions
export { ConstitutionLoader, buildConstitutionContext, REPO_INSTRUCTION_FILES } from './constitutions/index.js';

// Checkers
export { runAllCheckers, compileChecker, testsChecker, lintChecker, linksChecker, accessibilityChecker, runCustomChecker } from './checkers/index.js';
export type { CheckerOutput, CheckSummary } from './types/index.js';
export type { CheckerContext } from './checkers/index.js';

// Phases
export { buildPlanPrompt, planPhase } from './phases/plan.js';
export type { PlanPromptOpts } from './phases/plan.js';
export { buildPhase } from './phases/build.js';
export { checkPhase, disputeResolution } from './phases/check.js';
export { shipPhase } from './phases/ship.js';

// Reports
export { writeLocalRunReport, renderLocalRunReport } from './reports/local-run.js';
export type { LocalRunOutcome, LocalRunReport, LocalRunReportInput, LocalRunReportDeps } from './reports/local-run.js';

// Eval
export { loadGoldenCases, scoreSpec, judgeSpec, median, runJudgeSamples, runEval, toBaseline, compareToBaseline, isRouteAsserted, formatRegressionIssue, REGRESSION_ISSUE_TITLE, REGRESSION_ISSUE_MARKER, appendHistoryLine, parseHistory, renderTrend, summaryToHistoryRecord } from './eval/index.js';
export type { CaseResult, DeterministicCheck, EvalSummary, ExpectedRoute, GoldenCase, RunEvalOpts, Baseline, BaselineCase, BaselineComparison, RegressionIssue, JudgeAggregate, JudgeSample, HistoryRecord } from './eval/index.js';

// Utils
export { logEvent, logCost, readCosts, slugify, branchPrefixSlug, branchFor, setupWorktree, cleanupWorktree, gitFetch, shellEscape, ensureDir, isEscalation, escalationLine, codexDisabled } from './utils/index.js';
export { withGitLock, withFileLock } from './utils/lock.js';
export type { FileLockOptions } from './utils/lock.js';
export { watchChecks } from './utils/ci-watch.js';
export type { CiOutcome, WatchChecksOptions } from './utils/ci-watch.js';

// Usage
export { estimateTrailingSpend, formatUsageReport, watchUsage, priceFor, defaultTranscriptRoots, TRAILING_WINDOW_MS } from './usage/index.js';
export type { TrailingUsageOptions, WatchUsageOptions } from './usage/index.js';

// Types
export * from './types/index.js';
