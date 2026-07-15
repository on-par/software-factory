// packages/core/src/index.ts — Library entry point for programmatic use

// Config
export { loadModelsConfig, loadRoutesConfig, loadFactoryConfig, resolveTimeouts, resolveSkipCI, getFactoryPaths, getConstitutionsDir } from './config/index.js';
export type { ModelsConfig, RoutesConfig, FactoryConfig } from './config/index.js';

// Queue
export { validateQueue } from './queue/index.js';
export type { QueueValidationResult } from './queue/index.js';

// Models
export { ModelRegistry, isCommandAvailable, diagnoseModels, resolveModelOverrides } from './models/index.js';
export type { DoctorProbes, ModelDiagnosis, ModelOverrides } from './models/index.js';

// Router
export { ModelRouter, CliModelExecutor } from './router/index.js';
export type { RouterResult, FailoverReason, ModelExecutor, ModelExecutorContext } from './router/index.js';
export { StubModelExecutor } from './router/stub.js';
export type { StubModelExecutorOptions } from './router/stub.js';

// Coding harness contract
export { HarnessError, HARNESS_CATALOG, KNOWN_HARNESS_IDS, isAgenticHarness } from './harness/index.js';
export type { CodingHarness, HarnessFailureReason, HarnessRequest, HarnessResult, HarnessCatalogEntry } from './harness/index.js';
export { StubCodingHarness } from './harness/stub.js';
export type { StubCodingHarnessOptions, StubHarnessStep } from './harness/stub.js';
export { codingHarnessContractCases, makeContractRequest } from './harness/contract.js';
export type { HarnessContractCase, HarnessContractScenario, HarnessContractScenarios } from './harness/contract.js';
export { ClaudeCliHarness } from './harness/claude-cli.js';
export type { ClaudeExecFn } from './harness/claude-cli.js';
export { CodexCliHarness } from './harness/codex-cli.js';
export type { CodexExecFn } from './harness/codex-cli.js';
export { OllamaHttpHarness } from './harness/ollama-http.js';
export type { OllamaFetchFn } from './harness/ollama-http.js';
export { OpenCodeHarness } from './harness/opencode.js';
export type { OpenCodeExecFn } from './harness/opencode.js';
export { OllamaAgenticHarness, PATCH_PROPOSAL_SCHEMA } from './harness/ollama-agentic.js';
export type { OllamaAgenticExecFn, OllamaAgenticChange, OllamaAgenticProposal } from './harness/ollama-agentic.js';
export { classifyFailure } from './harness/classify.js';

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

// Local-small harness
export { applyLocalSmallPatchStep, createLocalSmallDryRun } from './local-small/stepwise.js';
export type { LocalSmallContextPack, LocalSmallDryRunInput, LocalSmallDryRunResult, LocalSmallLimits, LocalSmallPatchChange, LocalSmallPatchProposal, LocalSmallPatchStepInput, LocalSmallPatchStepResult, LocalSmallPatchStepStatus, LocalSmallStep, LocalSmallStepPlan } from './local-small/stepwise.js';

// Eval
export { loadGoldenCases, scoreSpec, judgeSpec, median, runJudgeSamples, runEval, toBaseline, compareToBaseline, isRouteAsserted, formatRegressionIssue, REGRESSION_ISSUE_TITLE, REGRESSION_ISSUE_MARKER, appendHistoryLine, parseHistory, renderTrend, summaryToHistoryRecord, buildLocalSmallScoreboard, renderLocalSmallScoreboardMarkdown } from './eval/index.js';
export type { CaseResult, DeterministicCheck, EvalSummary, ExpectedRoute, GoldenCase, RunEvalOpts, Baseline, BaselineCase, BaselineComparison, RegressionIssue, JudgeAggregate, JudgeSample, HistoryRecord, LocalSmallRuntime, LocalSmallScoreboardInput, LocalSmallScoreboardReport, LocalSmallScoreboardRow, LocalSmallScoreboardRun } from './eval/index.js';

// Utils
export { logEvent, logCost, readCosts, slugify, branchPrefixSlug, branchFor, setupWorktree, cleanupWorktree, gitFetch, shellEscape, ensureDir, isEscalation, escalationLine, codexDisabled } from './utils/index.js';
export { withGitLock, withFileLock } from './utils/lock.js';
export type { FileLockOptions } from './utils/lock.js';
export { watchChecks } from './utils/ci-watch.js';
export type { CiOutcome, WatchChecksOptions } from './utils/ci-watch.js';
export { sweepWorktrees, parseWorktreeList, findCredentialFiles, scrubFile, zeroFill, formatGcReport } from './utils/worktree-gc.js';
export type { GcReport, GcCandidate, GcReason, WorktreeListEntry, SweepDeps } from './utils/worktree-gc.js';
export { runCommand, describeCommandFailure } from './utils/command-runner.js';
export type { RunCommandOptions, CommandResult } from './utils/command-runner.js';

// Usage
export { estimateTrailingSpend, formatUsageReport, watchUsage, priceFor, defaultTranscriptRoots, TRAILING_WINDOW_MS } from './usage/index.js';
export type { TrailingUsageOptions, WatchUsageOptions } from './usage/index.js';

// Types
export * from './types/index.js';
