// packages/core/src/index.ts — Library entry point for programmatic use
//
// This is the narrow public API of @on-par/factory-core (ADR-0004). Implementation
// details live behind '@on-par/factory-core/internal'; test doubles and contract
// kits live behind '@on-par/factory-core/testing'.

// Config
export type {
  AutoFailoverSettings,
  EnvironmentPortsSettings,
  EnvironmentProxySettings,
  FactoryConfig,
  IngestSettings,
  ModelsConfig,
  RoutesConfig,
} from './config/index.js';
export {
  getConstitutionsDir,
  getFactoryPaths,
  loadFactoryConfig,
  loadFactoryConfigForRepo,
  loadModelsConfig,
  loadRoutesConfig,
  resolveAutoFailover,
  resolveDefectWindowDays,
  resolveEnvironmentPorts,
  resolveEnvironmentProxy,
  resolveIngestConfig,
  resolvePlanApproval,
  resolveProcessGroupGraceMs,
  resolveSkipCI,
  resolveTimeouts,
} from './config/index.js';
export type { EffectiveModelPins, EffectiveUsageCap, EfficiencyPolicy, RepoFactoryConfig } from './config/repo.js';
export {
  applyRepoConfig,
  describeEffectiveConfig,
  loadRepoConfig,
  resolveCodexDisabled,
  resolveEffectiveModelPins,
  resolveEfficiencyPolicy,
  resolveUsageCap,
} from './config/repo.js';

// Environment
export type {
  AcquirePortLeaseOptions,
  IsPortFreeFn,
  LeaseHealth,
  LeaseLivenessProbes,
  PortLease,
  ReapedLease,
  ReapReason,
} from './environment/index.js';
export {
  acquirePortLease,
  defaultIsPidAlive,
  defaultIsPortFree,
  headlessEnv,
  inspectPortLeases,
  laneEnv,
  leaseEnv,
  PortLeaseError,
  readPortLeases,
  reapStalePortLeases,
  recordLeasePgid,
  releasePortLease,
} from './environment/index.js';
export type { FindPortListenersFn, OrphanEvent, PortListener } from './environment/orphans.js';
export { defaultFindPortListeners, reapOrphanProcesses } from './environment/orphans.js';
export type { KillOutcome, KillProcessGroupOptions } from './environment/process-groups.js';
export { defaultIsProcessGroupAlive, killProcessGroup, ProcessGroupTracker } from './environment/process-groups.js';

// Proxy
export type { LaneProxy, LaneProxyOptions, LaneProxySettings, ProxyState } from './proxy/index.js';
export {
  clearProxyState,
  createLaneProxy,
  isProxyRunning,
  laneBaseUrl,
  laneHostLabel,
  laneHostname,
  readProxyState,
  writeProxyState,
} from './proxy/index.js';

// Queue
export type {
  ParsedQueue,
  QueueDiagnostic,
  QueueEntry,
  QueueSnapshot,
  QueueSnapshotEntry,
  QueueValidationResult,
} from './queue/index.js';
export { parseQueue, readQueue, rewriteQueueForDecomposition, validateQueue } from './queue/index.js';

// Hosted execution (control plane)
export type {
  AcquireLeaseInput,
  CreateHostedJobInput,
  HostedClock,
  HostedJobResultDetail,
  HostedJobStore,
  HostedJobStoreOptions,
  JobLeaseResult,
  JobUpdateResult,
  LeaseRejectionReason,
  PollForLeaseInput,
  PollResult,
  ReclaimJobResult,
  RegisterRunnerInput,
  StoredHostedJob,
  StoredRunner,
  UpdateRejectionReason,
} from './hosted/store.js';
export { createHostedJobStore } from './hosted/store.js';
export type { SqliteHostedJobStore, SqliteHostedJobStoreOptions } from './hosted/store-sqlite.js';
export { createSqliteHostedJobStore } from './hosted/store-sqlite.js';
export type { HostedJobStoreBackend, ResolveHostedJobStoreOptions } from './hosted/store-resolve.js';
export { resolveHostedJobStore } from './hosted/store-resolve.js';
export type { DockerRunnerConfig, DockerRunnerOutcome, FakeRunnerConfig, FakeRunnerOutcome } from './hosted/runner.js';
export { runDockerRunner, runFakeRunner } from './hosted/runner.js';
export type { WatchdogEscalation, WatchdogPolicy, WatchdogReport } from './hosted/watchdog.js';
export { runWatchdogSweep } from './hosted/watchdog.js';
export type {
  CloneOutcome,
  ContainerCleanupProof,
  ContainerEngine,
  ContainerJobConfig,
  ContainerJobOutcome,
  ContainerRunResult,
  ContainerRunSpec,
  PreparedWorkspace,
} from './hosted/container.js';
export { runContainerJob } from './hosted/container.js';
export type { HostedJobSummary } from './hosted/summary.js';
export { summarizeHostedJob, summarizeHostedJobs } from './hosted/summary.js';
export type { HostedSmokeConfig, HostedSmokeOutcome } from './hosted/smoke.js';
export { runHostedSmoke } from './hosted/smoke.js';
// Re-exported so consumers gating on the hosted-exec flag (e.g. the CLI) go through
// core rather than reaching past it to `@on-par/contracts` directly.
export { hostedExecEnabled } from '@on-par/contracts';
export type {
  AuthorityBroker,
  AuthorityCleanupProof,
  AuthorityFailure,
  AuthorityMount,
  AuthorityMountEngine,
  AuthorityRunOutcome,
  PrepareAuthorityConfig,
  ResolvedSecret,
} from './hosted/authority.js';
export { AUTHORITY_REDACTION_MASK, redactSecrets, withAuthority } from './hosted/authority.js';
export type {
  GitHubAuthorityBrokerOptions,
  GitHubCredentialBundle,
  GitHubTokenKind,
  MintGitHubToken,
  MintGitHubTokenInput,
  MintedGitHubToken,
} from './hosted/github-authority.js';
export {
  prepareGitHubAuthority,
  prototypeFallbackMint,
  redactGitHubCredential,
  resolveHostedAuthority,
} from './hosted/github-authority.js';
export type {
  ControlPlaneResponse,
  HostedControlPlaneOptions,
  HostedControlPlaneServer,
} from './hosted/control-plane.js';
export { createHostedControlPlaneServer, handleHostedControlPlaneRequest } from './hosted/control-plane.js';
export type {
  HostedControlPlaneClient,
  HostedControlPlaneFetchFn,
  HttpHostedControlPlaneClientOptions,
  OneJobRunnerConfig,
  OneJobRunnerOutcome,
  PollForLeaseResult,
  RegisteredRunner,
} from './hosted/runner-client.js';
export { createHttpHostedControlPlaneClient, runOneJobRunner } from './hosted/runner-client.js';

// Work requests
export type {
  WorkRequest,
  WorkRequestReference,
  WorkRequestSourceKind,
  WorkRequestState,
  WorkSourceAdapter,
} from './work/index.js';
export {
  closedWorkSkipReason,
  createDefaultWorkSourceRegistry,
  InvalidWorkRequestInputError,
  UnsupportedWorkSourceError,
  WorkSourceRegistry,
} from './work/index.js';
export type { GithubIssueParams, WorkIssueClient } from './work/github-issue.js';
export { createGithubIssueAdapter, createOctokitIssueClient, GITHUB_ISSUE_SOURCE } from './work/github-issue.js';
export type { BriefFileReader, LocalBriefParams } from './work/local-brief.js';
export { createFsBriefReader, createLocalBriefAdapter, LOCAL_BRIEF_SOURCE } from './work/local-brief.js';
export type { LocalOnlyPolicy } from './work/local-only.js';
export { InvalidWorkspaceError, resolveLocalOnlyPolicy } from './work/local-only.js';

// Events
export type { FollowEventsOptions } from './events/index.js';
export { followEvents, readEvents } from './events/index.js';
export type { EventKind, EventTraits, LaneStatus } from './events/kinds.js';
export {
  eventTraitsFor,
  EVENT_TRAITS,
  isParkKind,
  laneStatusOf,
  severityOf,
  UNKNOWN_EVENT_TRAITS,
} from './events/kinds.js';

// Run outcome
export type { BuildRoute, ParkReason, RunOutcome } from './run/outcome.js';
export { parkEvents, parkReasonFor } from './run/outcome.js';

// Run policy
export type { RunBudget, RunPolicy } from './run/policy.js';

// Run ports (#674)
export type { Environment, Workspace } from './run/ports.js';
export { acquireLaneEnvironment, localOnlyWorkspace, worktreeWorkspace } from './run/ports.js';

// Run composition (#675)
export type { RunPorts, RunRequest } from './run/run-issue.js';
export { runIssue } from './run/run-issue.js';

// Lifecycle bus (#591)
export type {
  LaneLifecycleEvent,
  LaneLifecycleListener,
  LaneLifecyclePhase,
  LaneLifecycleStatus,
  LifecycleBus,
} from './bus/index.js';
export { createLifecycleBus, lifecycleBus } from './bus/index.js';

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

// Provider circuit breaker
export type { BreakerEntry, BreakerStatus } from './router/breaker.js';
export { gateBuildOnBreaker, parseResetCooldownMs, ProviderBreaker } from './router/breaker.js';

// Cross-run failure-signature memory (#740)
export type { ReworkHistoryEntry } from './checkers/rework-history.js';
export { ReworkHistory } from './checkers/rework-history.js';

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

// Readiness
export {
  EPIC_REQUIRED_FIELDS,
  FACTORY_BUG_REQUIRED_FIELDS,
  FACTORY_TASK_REQUIRED_FIELDS,
  scoreIssueReadiness,
} from './readiness/index.js';

// Checkers
export type { DesignSmell, DesignSmellVerdict } from './checkers/design-smells.js';
export { designSmellsChecker } from './checkers/design-smells.js';
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
export {
  createFileApprovalGate,
  listPendingApprovals,
  PLAN_SPEC_PREVIEW_BYTES,
  respondToApproval,
} from './approvals/index.js';

// Steering
export type { ConsumedSteering, SteeringAttachment, SteeringMessage } from './steering/index.js';
export {
  applySteering,
  describeSteering,
  drainSteering,
  extractPathCandidates,
  listQueuedSteering,
  MAX_ATTACHMENT_BYTES,
  queueSteeringMessage,
  steeringFileFor,
} from './steering/index.js';

// Reports
export type { EvidencePackGatherInput, EvidencePackRenderInput } from './reports/evidence-pack.js';
export { gatherEvidencePack, renderEvidencePack } from './reports/evidence-pack.js';
export type { LocalRunOutcome, LocalRunReport, LocalRunReportDeps, LocalRunReportInput } from './reports/local-run.js';
export { readIssueEvents, renderLocalRunReport, writeLocalRunReport } from './reports/local-run.js';
export type {
  BenchmarkArtifactsInput,
  BenchmarkManifest,
  BenchmarkModelAttempt,
  BenchmarkRunFailure,
} from './reports/benchmark-artifacts.js';
export {
  BENCHMARK_MANIFEST_VERSION,
  buildBenchmarkManifest,
  InvalidArtifactsDirError,
  resolveArtifactsDir,
  writeBenchmarkArtifacts,
} from './reports/benchmark-artifacts.js';

// KPIs
export type {
  CommitSource,
  DefectSourceClient,
  DefectSources,
  HealthKpis,
  HumanSourceClient,
  KpiDriftMetricResult,
  KpiDriftReport,
  KpiHistoryRecord,
  MergedPrRef,
  PrCommentSource,
  PrSource,
  RepoCommitSource,
  RepoIssueSource,
} from './kpis/index.js';
export {
  appendKpiHistoryLine,
  computeHealthKpis,
  computeKpiDrift,
  DEFAULT_DEFECT_WINDOW_DAYS,
  detectPostMergeDefects,
  fetchDefectSources,
  fetchHumanEventSources,
  formatKpiLines,
  hasUnresolvedPark,
  HUMAN_EVENT_TYPES,
  isDefectWindowClosed,
  isHumanEvent,
  KPI_DRIFT_THRESHOLD_RATIO,
  KPI_DRIFT_WINDOW_SIZE,
  kpisToHistoryRecord,
  mergedPrRefs,
  parseKpiHistory,
  reconstructHumanEvents,
  renderKpiDriftLine,
  renderKpiReport,
  renderKpiTrend,
} from './kpis/index.js';

// Discovery
export type { AuthorDraftEpicDeps, AuthorDraftEpicOptions, AuthorDraftEpicResult } from './discovery/author.js';
export {
  authorDraftEpic,
  DEFAULT_OWNER_QUESTIONS,
  DISCOVERY_LABEL,
  EXPLORING_LABEL,
  ideaMarker,
} from './discovery/author.js';
export type {
  DiscoveryCandidate,
  DiscoveryScanDeps,
  DiscoveryScanOptions,
  DiscoveryScanResult,
  DiscoverySignal,
  DiscoverySignalSource,
} from './discovery/index.js';
export { DEFAULT_MAX_CANDIDATES, runDiscoveryScan } from './discovery/index.js';
export type {
  AdvanceDraftEpicDeps,
  AdvanceDraftEpicOptions,
  AdvanceDraftEpicResult,
  DraftStory,
  EpicLifecycle,
  EpicView,
  GherkinScenario,
} from './discovery/promote.js';
export {
  advanceDraftEpic,
  ARCHIVED_LABEL,
  classifyLifecycle,
  DEFAULT_MAX_STORIES,
  READY_LABEL,
  renderStoryBody,
  seedStories,
  VALIDATED_LABEL,
  WONTFIX_LABEL,
} from './discovery/promote.js';

// Ingest
export type { AutoIngestDeps, AutoIngestOptions, AutoIngestResult } from './ingest/index.js';
export { issueFromFactoryBranch, runAutoIngest } from './ingest/index.js';

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
