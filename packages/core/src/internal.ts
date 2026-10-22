// packages/core/src/internal.ts — Implementation details consumed by the factory's
// own packages (cli, tui, root scripts). No stability guarantee: these exports may
// change or disappear without notice. See ADR-0004 for the public/internal split.
// Garden harvest (#2083)
export type {
  GardenCluster,
  GardenDimension,
  GardenReportMeta,
  GardenTracking,
  HarvestedEvent,
} from './garden/harvest.js';
export {
  DEFAULT_GARDEN_MAX_CLUSTERS,
  DEFAULT_GARDEN_SINCE,
  capGardenClusters,
  clusterCheckFailures,
  clusterGarden,
  filterGardenWindow,
  parseGardenDuration,
  readHarvestEvents,
  renderGardenJson,
  renderGardenReport,
} from './garden/harvest.js';
// Garden dedup (#2102)
export {
  dedupGardenClusters,
  filterGardenOnlyNew,
  findGardenTrackingIssue,
  gardenClusterFingerprint,
  gardenKeyMarker,
  markGardenTrackingUnknown,
} from './garden/dedup.js';
// Failure fingerprint & evidence
export { captureFailure, fingerprintFailure, normalizeFailureMessage } from './failure/index.js';
export type {
  CaptureFailureInput,
  EvidencePack,
  FailureOrigin,
  FailurePhase,
  FailureSignatureInput,
  FingerprintedFailure,
} from './types/index.js';

// Auto-file a fingerprinted bug (#373)
export type {
  CandidateIssue,
  FileBugAction,
  FileBugInput,
  FileBugResult,
  FilingGitHubClient,
  OctokitFilingClientOptions,
} from './filing/index.js';
export {
  createOctokitFilingClient,
  DEFAULT_BUG_LABELS,
  fileBug,
  findIssueByMarker,
  findMatchingIssue,
  fingerprintMarker,
  renderBugBody,
  renderOccurrenceComment,
  renderUpstreamOccurrenceComment,
  resolveTargetRepo,
} from './filing/index.js';

// Evidence sanitizer for untrusted text (#1841, #1852)
export { stripHiddenContent } from './filing/sanitize.js';

// Redacted upstream factory report (#1858)
export { REDACTION_PLACEHOLDERS, redactText, type RedactionClass, type RedactionContext } from './filing/redact.js';
export type { UpstreamEnvironment, UpstreamReport, UpstreamReportInput } from './filing/upstream.js';

// Send upstream reports with outbox fallback (#1860)
export type {
  PendingUpstreamReport,
  UpstreamOutboxEntry,
  UpstreamSendInput,
  UpstreamSendOutcome,
  UpstreamSendResult,
} from './filing/upstream-send.js';
export {
  classifyUpstreamSendError,
  defaultUpstreamLedgerPath,
  defaultUpstreamOutboxDir,
  sendUpstreamReports,
  writeUpstreamOutbox,
} from './filing/upstream-send.js';
export {
  buildUpstreamReport,
  factoryStackFrames,
  UPSTREAM_TITLE_PREFIX,
  upstreamInputFromEvidence,
  upstreamReportMarker,
} from './filing/upstream.js';
export type { FilingDecision, FilingLedger, FilingPolicy, FilingSkipReason } from './filing/policy.js';
export {
  DEFAULT_FILING_POLICY,
  emptyLedger,
  evaluateFilingPolicy,
  isAutoMergeBlocked,
  labelsFor,
  recordFiled,
  recordPark,
  rollDay,
  touchesSensitiveScope,
} from './filing/policy.js';
// Config
export { resolveStateRoot, STATE_ROOT_ENV } from './config/state-root.js';
export { resolveFilingPolicy, resolvePrClassifierPolicy, type EffectivePrClassifierPolicy } from './config/index.js';
export { describeDraftPrPolicy, resolveDraftPrPolicy, type EffectiveDraftPrPolicy } from './config/run-section.js';
export type { EffectiveConfig, TrustTier } from './config/repo.js';
export { resolveBaseHealthChecks, resolveHermeticGit } from './config/base-health.js';
export { resolveEffectiveConfig, resolveReviewFloorRules, resolveTrustTier } from './config/repo.js';
export { resolveExperimental, resolveLocalOnly, resolveBranchPrefix, resolveHostMaxBuilds } from './config/index.js';
export { evaluateLoadGuard, formatLoadHold, readHostLoad, type LoadGuardDecision } from './environment/load-guard.js';
export { hostAgentJobsDir, hostBuildSlotsDir, listHostSlots, withHostAgentJobLease } from './environment/host-slots.js';
export { withHostBuildSlot, type HostAgentJobKind, type HostSlotStatus } from './environment/host-slots.js';
export { createRunSlotGate, withRunAndHostBuildSlot, type RunSlotGate } from './environment/run-slots.js';
export { FACTORY_RUNTIME_CONFIG_KEYS, resolveHostLoadGuard, resolveHostMaxAgentJobs } from './config/index.js';
export { isTrustedApprover, createOctokitCollaboratorPermissionClient } from './queue/approval.js';
export type { CollaboratorPermissionClient, TrustedApproverOptions } from './queue/approval.js';
export {
  migrateRepoConfigToYaml,
  REPO_CONFIG_FILENAMES,
  REPO_CONFIG_YAML_HEADER,
  readRepoConfigFile,
  resolveRepoConfigPath,
  rewriteRepoConfigFile,
  setRepoConfigValue,
} from './config/repo-config-file.js';
export type { RepoConfigYamlMigration } from './config/repo-config-file.js';
export { CONFIG_EXAMPLE_OMITTED_KEYS, renderConfigExample } from './config/example.js';
export { resolveEvidenceAllowlist, type EvidenceAllowlist } from './checkers/evidence-allowlist.js';
export { runEvidencePlan, type EvidencePlanResult, type EvidenceRunnerContext } from './checkers/evidence-plan.js';
// Design artifact (#422)
export { DesignArtifactSchema, parseDesignArtifact, readDesignArtifact, renderDesignArtifact } from './design/index.js';
// Concrete coding harnesses
export { classifyFailure } from './harness/classify.js';
export { type ClaudeExecFn, ClaudeCliHarness } from './harness/claude-cli.js';
export { type CodexExecFn, CodexCliHarness } from './harness/codex-cli.js';
export { type HarnessCheckOptions, type HarnessCheckResult, runHarnessCheck } from './harness/check.js';
export { buildHarnessCommand, CommandHarness } from './harness/command.js';
export { isAgenticHarness, isRetryableFailure, NON_RETRYABLE_FAILURE_REASONS } from './harness/index.js';
export type { OllamaAgenticChange, OllamaAgenticExecFn, OllamaAgenticProposal } from './harness/ollama-agentic.js';
export { OllamaAgenticHarness, PATCH_PROPOSAL_SCHEMA } from './harness/ollama-agentic.js';
export { OllamaHttpHarness, type OllamaFetchFn } from './harness/ollama-http.js';
export { classifyOpenCodeErrorType, parseOpenCodeJson } from './harness/opencode.js';
export { type OpenCodeExecFn, OpenCodeHarness } from './harness/opencode.js';
export { parsePiJson, type PiExecFn, PiHarness } from './harness/pi.js';
export * as openCodeVersion from './harness/opencode-version.js';
export { type DockerEngineOptions, createDockerEngine } from './hosted/docker.js';
export type { OrphanContainer, ReapedContainer } from './hosted/orphans.js';
export { listOrphanContainers, reapOrphanContainers } from './hosted/orphans.js';
// Router
export { harnessCliCommand } from './harness/catalog.js';
export { isHarnessCliPresent } from './models/index.js';
export { CliModelExecutor } from './router/index.js';

// Phase helpers
export { buildPlanPrompt, type PlanPromptOpts } from './phases/plan.js';
export { buildTriagePrompt, normalizeTriageQueue, parseTriageCandidates } from './triage/index.js';
export { dropQueuedIssues, parseOpenPrIssues } from './triage/index.js';

// Board-constrained local lane dispatch (#848)
export type {
  BoardQueueDispatcher,
  BoardQueueOrdering,
  LocalLaneCandidate,
  QueueIntentReader,
} from './phases/board-queue-dispatch.js';
export { createBoardQueueDispatcher } from './phases/board-queue-dispatch.js';

// ProjectV2 queue-intent scheduler (#867)
export type {
  BoardQueueScheduler,
  BoardQueueSchedulerOptions,
  ProjectQueueProjectionReader,
} from './phases/board-queue-scheduler.js';
export { createBoardQueueScheduler } from './phases/board-queue-scheduler.js';

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
export { defaultTranscriptRoots, priceFor, TRAILING_WINDOW_MS, type RunUsageHarnessInput } from './usage/index.js';
export { harnessHasUsageSignal, resolveRunUsageHarness, USAGE_NOT_AVAILABLE_FOR_AGENT } from './usage/index.js';
export { readClaudeAccessToken } from './usage/subscription.js';

// Utils
export type {
  CiFailureClass,
  CiJobLike,
  CiJobStepLike,
  CiNoChecksInfo,
  CiOutcome,
  CiRerunBudget,
  CiRescue,
  CiRescueFailure,
  CiWatchProgress,
  InfraRerunOutcome,
  InfraRerunWatchOptions,
  WatchChecksOptions,
} from './utils/ci-watch.js';
export { collectCiFailureEvidence } from './utils/ci-evidence.js';
export {
  classifyCiFailure,
  DEFAULT_CI_DEADLINE_MS,
  DEFAULT_CI_NO_CHECKS_GRACE_MS,
  isPassingConclusion,
  noChecksVerdictMs,
  resolveCiNoChecksGraceMs,
  watchChecks,
  watchChecksWithInfraRerun,
} from './utils/ci-watch.js';
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
  type LaneWorktreeReapResult,
  branchFor,
  branchPrefixSlug,
  LEGACY_BRANCH_PREFIX,
  factoryBranchPrefixes,
  factoryBranchIssue,
  cleanupWorktree,
  colorEnabled,
  defaultRemoteBase,
  ensureDir,
  escalationLine,
  formatEventLine,
  getIssueTitle,
  gitFetch,
  isEscalation,
  levelForType,
  logCost,
  logEvent,
  readCosts,
  reapCleanShipWorktree,
  reapLaneWorktree,
  setupWorktree,
  shellEscape,
  slugify,
} from './utils/index.js';
export {
  claudeConfigDirOverride,
  claudeKeychainService,
  claudeStoredSessionState,
  hasClaudeLoginEvidence,
} from './utils/claude-config.js';
export type { ClaudeSessionState } from './utils/claude-config.js';
export { formatStopMarker, readStopMarker, type StopMarker, type StopSource } from './utils/stop-marker.js';
export { hasOpencodeLoginEvidence } from './utils/opencode-config.js';
export type { MicroVmLifecycleOptions, ReapedMicroVm, WorktreeSandbox } from './utils/microvm.js';
export {
  createMicroVm,
  listMicroVms,
  microVmName,
  reapOrphanMicroVm,
  removeMicroVm,
  worktreeSandboxFor,
} from './utils/microvm.js';
export type { FileLockOptions, SyncFileLockOptions } from './utils/lock.js';
export { withFileLock, withFileLockSync, withGitLock } from './utils/lock.js';
export type { RunLockHolder, RunLockOptions } from './utils/run-lock.js';
export { readRunLockHolder, RunLockHeldError, withRunLock } from './utils/run-lock.js';
export {
  ensureWorktreeParentExcluded,
  formatWorktreeLocation,
  laneWorktreePath,
  resolveWorktreeRoot,
} from './utils/worktree-location.js';
export type {
  GcCandidate,
  GcHeadPrState,
  GcHeldCandidate,
  GcReason,
  GcReport,
  SweepDeps,
  WorktreeListEntry,
} from './worktree/worktree-gc.js';
export {
  countUnpushedCommits,
  findCredentialFiles,
  formatGcReport,
  isWorktreeClean,
  parseWorktreeList,
  scrubFile,
  sweepWorktrees,
  zeroFill,
} from './worktree/worktree-gc.js';
export { findWorktreeKeep } from './worktree/worktree-keeps.js';
// Daemon repo registry (~/.factory/registry.json) (#781)
export {
  type RepoRegistry,
  type RepoRegistryEntry,
  type RepoRegistryListing,
  type RepoState,
  type WriteRegistryOptions,
  defaultRegistryPath,
  dispatchableRepos,
  emptyRegistry,
  getRepo,
  listRepos,
  loadRegistry,
  upsertRepo,
  writeRegistry,
} from './daemon/registry.js';

export { createGithubLaneClaimStalenessProbe, releaseLaneClaim } from './run/lane-file-guard.js';
export type { LaneClaimStalenessProbe } from './run/lane-file-guard.js';
// Daemon lane state resolution (#843)
export { type DaemonLaneContext, createDaemonLaneContext } from './daemon/lane-context.js';
export { type DaemonOrchestrator, runDaemonRepo } from './daemon/run-repo.js';
export type {
  EngineHandle,
  EngineRunner,
  EngineSupervisor,
  EngineSupervisorOptions,
} from './daemon/engine-supervisor.js';
export {
  DEFAULT_STALE_THRESHOLD_MS,
  DEFAULT_SUPERVISOR_POLL_MS,
  superviseActiveRepos,
  superviseEngine,
} from './daemon/engine-supervisor.js';

// Daemon control-plane HTTP server (#777)
export type { FactorydOptions, FactorydServer } from './daemon/factoryd-http.js';
export { createFactorydServer, DEFAULT_FACTORYD_PORT } from './daemon/factoryd-http.js';

// Durable explicit daemon runs (#1393)
export type { DaemonRunRecord, DaemonRunStatus } from './daemon/run-store.js';
export {
  createDaemonRunExclusive,
  daemonRunFile,
  isValidRunId,
  MAX_DETAIL_CHARS,
  readDaemonRun,
  writeDaemonRun,
} from './daemon/run-store.js';
export type {
  DaemonRunDeps,
  DaemonRunExecutor,
  SubmitDaemonRunResult,
  SubmitRunFailureReason,
  SubmitRunRequest,
} from './daemon/runs-submit.js';
export { executeDaemonRun, submitDaemonRun } from './daemon/runs-submit.js';

// Daemon runtime state: pid/port/log files under ~/.factory (#1177)
export type { AcquirePidFileOptions, AcquirePidFileResult, DaemonRuntimePaths } from './daemon/runtime-state.js';
export {
  acquirePidFile,
  createDaemonLogSink,
  daemonRuntimePaths,
  releaseRuntimeFiles,
  writePortFile,
} from './daemon/runtime-state.js';

// Daemon attach gate (#778)
export type { AttachFailureReason, AttachRepoDeps, AttachRepoResult } from './daemon/repos-attach.js';
export { attachRepo, parseRemoteSlug, readOriginUrl } from './daemon/repos-attach.js';

// Daemon checkout validation gate (#1398)
export type {
  CheckoutValidationDeps,
  CheckoutValidationFailureReason,
  CheckoutValidationResult,
  ValidatedCheckout,
} from './daemon/checkout-validation.js';
export { parseCheckoutRequest, validateCheckout } from './daemon/checkout-validation.js';

// Daemon pause/resume gate (#779)
export type { SetRepoStateFailureReason, SetRepoStateResult, SettableRepoState } from './daemon/repos-pause-resume.js';
export { setRepoState } from './daemon/repos-pause-resume.js';

// GitHub-label-backed work queue (#824)
export type {
  EnqueueOutcome,
  EnqueueResult,
  GithubQueue,
  GithubQueueOptions,
  QueueClaim,
  QueueClearAction,
  QueueClearEntry,
  QueueClearOutcome,
  QueueClearPreview,
  QueueClearPreviewEntry,
  QueueClearResult,
  QueueGitHubClient,
  QueueIssue,
  QueueLabelSpec,
  QueueMigrationStep,
  QueuePreflight,
  QueuePreflightDecision,
  QueueReleaseOutcome,
} from './queue/github-queue.js';
export {
  claimedByLabel,
  CLAIMED_BY_LABEL_PREFIX,
  claimExpiresLabel,
  CLAIM_EXPIRES_LABEL_PREFIX,
  createGithubQueue,
  createOctokitQueueClient,
  defaultClaimantId,
  DEFAULT_CLAIM_LEASE_MS,
  IN_PROGRESS_LABEL,
  LANE_LABEL_PREFIX,
  laneLabel,
  laneSlug,
  MAX_LABEL_NAME_LENGTH,
  parseClaimExpiresLabel,
  PARKED_LABEL,
  DECOMPOSED_LABEL,
  planQueueMigration,
  QUEUED_LABEL,
  QUEUE_ORDER_LABEL_PREFIX,
  queueOrderLabel,
  queueLabelSpecs,
  readGithubQueueSnapshot,
} from './queue/github-queue.js';
export type { QueueEntry, QueueSnapshot, QueueSnapshotEntry } from './queue/index.js';
export { formatQueueOrderConflict, type QueueOrderConflict, type QueueOrderLabelProblem } from './queue/queue-order.js';

// Factory App admission-state compatibility (#1497)
export type {
  AdmissionLookup,
  AdmissionRecord,
  AdmissionState,
  AdmissionStateReader,
  QueueCompatibilityVerdict,
} from './admission/index.js';
export {
  ADMISSION_SNAPSHOT_VERSION,
  ADMISSION_STATE_FILENAME,
  classifyQueueCompatibility,
  createFileAdmissionStateReader,
  FACTORY_APP_REPAIR_HINT,
  formatAdmissionConflict,
  withAdmissionGuard,
} from './admission/index.js';

// Backend-agnostic queue seam (#1499)
export { createGithubQueueBackend, type GithubQueueBackendOptions, type QueueBackend } from './queue/queue-backend.js';

// Stale-claim reaping (#999, lease-based since #1500)
export type { ReleaseStaleClaimsOptions, StaleClaim, StaleClaimRelease } from './queue/stale-claims.js';
export { findStaleClaims, releaseStaleClaims } from './queue/stale-claims.js';
export type { StatelessLaneIssue } from './queue/stateless-lane.js';
export { findStatelessLaneIssues, listRepoLaneLabels, listStatelessLaneIssues } from './queue/stateless-lane.js';
export * from './queue/unpark.js';

// Green-and-ready PR reporting (#1000)
export type {
  FindUnmergedGreenPrsOptions,
  GreenPrGitHubClient,
  OpenPullRequestSummary,
  UnmergedGreenPr,
} from './utils/green-prs.js';
export { createOctokitGreenPrClient, findUnmergedGreenPrs, owningIssueForPr } from './utils/green-prs.js';

// Read-only GitHub ProjectV2 queue-intent polling (#847)
export type {
  ProjectBoardConfig,
  ProjectBoardPoller,
  ProjectBoardPollerOptions,
  QueueIntentItem,
  QueueIntentSnapshot,
  QueueIntentStatus,
} from './queue/project-board-poller.js';
export { createProjectBoardPoller, DEFAULT_PROJECT_BOARD_POLL_MS } from './queue/project-board-poller.js';

// Daemon-ready ProjectV2 queue intent projection (#866)
export type {
  ProjectQueuePoller,
  ProjectQueuePollerOptions,
  ProjectQueueProjection,
} from './projects/project-queue-poller.js';
export { createProjectQueuePoller, DEFAULT_PROJECT_QUEUE_POLL_MS } from './projects/project-queue-poller.js';
export type { ProjectQueueStatus } from './projects/project-queue-reader.js';

// gh-authenticated ProjectV2 queue GraphQL client + live poller (#1046)
export type { GithubProjectQueuePollerOptions, ProjectGraphqlClient } from './projects/github-project-graphql.js';
export { createGithubProjectQueuePoller, createOctokitGraphqlClient } from './projects/github-project-graphql.js';

// Single-poller cached subscription-usage snapshot (#1029)
export type {
  UsageCoordinator,
  UsageCoordinatorOptions,
  UsageCoordinatorState,
  WriteUsageStateOptions,
} from './usage/coordinator.js';
export {
  createUsageCoordinator,
  DEFAULT_USAGE_POLL_MS,
  defaultUsageStatePath,
  loadUsageState,
  writeUsageState,
} from './usage/coordinator.js';

// UsageCoordinator admission-control acquire() API and grant ledger (#1030)
export type { AcquireResult, GrantLedger, GrantLedgerEntry, GrantRequest } from './usage/grant-ledger.js';
export {
  defaultGrantLedgerPath,
  DEFAULT_GRANT_TTL_MS,
  isCappedModel,
  loadGrantLedger,
  pruneGrants,
  USAGE_ADMISSION_CEILING_PCT,
  USAGE_GRANT_RESERVATION_PCT,
  writeGrantLedger,
} from './usage/grant-ledger.js';

// Engine lane parks and resumes on acquire denial (#1032)
export type { LaneAcquire, LaneAdmission, LaneScheduler, LaneSchedulerOptions } from './usage/lane-scheduler.js';
export { createLaneScheduler } from './usage/lane-scheduler.js';

// Standalone local UsageCoordinator fallback (#1033)
export { createLocalUsageCoordinator, type LocalUsageCoordinatorOptions } from './usage/local-coordinator.js';
export { selectUsageCoordinator, type SelectUsageCoordinatorOptions } from './usage/select-coordinator.js';

// Local queue reprioritization audit records (#869)
export type { QueueReprioritizationRecord } from './types/index.js';
export { createQueueRationaleAuditor, type QueueRationaleAuditor } from './queue/reprioritization-audit.js';

// Publish only coarse daemon lifecycle status to configured ProjectV2 items (#868)
export type { ProjectStatusWriter, ProjectStatusWriterOptions } from './projects/project-status-writer.js';
export { createProjectStatusWriter } from './projects/project-status-writer.js';

// Coarse ProjectV2 status writing (#849)
export type {
  ProjectBoardCoarseStatus,
  ProjectBoardStatusConfig,
  ProjectBoardStatusItem,
  ProjectBoardStatusValues,
  ProjectBoardStatusWriter,
  ProjectBoardStatusWriterOptions,
} from './queue/project-board-status-writer.js';
export { createProjectBoardStatusWriter } from './queue/project-board-status-writer.js';
// Daemon detach gate (#780)
export type { BeginDetachResult, DetachRepoDeps, DrainOutcome } from './daemon/repos-detach.js';
export {
  beginDetach,
  DEFAULT_DRAIN_POLL_INTERVAL_MS,
  DEFAULT_DRAIN_TIMEOUT_MS,
  DRAIN_BLOCKING_STATUSES,
  drainAndDetach,
  isDrainSafe,
} from './daemon/repos-detach.js';
// Sandbox command wrapping — used by the CLI's doctor probe (#1008)
export { wrapCommandInSandbox, shouldProxyEgress, isEgressEnforced } from './sandbox/index.js';
export { resolveConfiguredWritablePaths } from './sandbox/writable-paths.js';
export {
  startEgressProxy,
  egressSummaryMessage,
  egressHostMessage,
  isTelemetryHost,
  TELEMETRY_HOST_PATTERNS,
  type EgressProxy,
} from './sandbox/egress-proxy.js';
export { createRunRuntime, type RunRuntime } from './daemon/run-runtime.js';
export { findOpenPR, type PrLookup } from './phases/ship.js';
export * from './run/adopt-pr.js'; // findAdoptablePr + the shared open-PR lookup (#3439)
export { detectLowerSliceChange, parkOnLowerSliceChange } from './phases/stack-review-change.js';
export type {
  LowerSliceChange,
  LowerSliceChangeDetection,
  ReviewChangeParkResult,
} from './phases/stack-review-change.js';
export { readReviewApproval, readStackSliceGate } from './phases/stack-approval.js';
export type {
  StackPullReviews,
  StackSliceGate,
  StackSliceGateReader,
  StackSliceReview,
} from './phases/stack-approval.js';
export { createShipExecutor } from './daemon/ship-executor.js';

// Review verdict (#1679)
export type {
  AcceptanceCriterionFinding,
  ReviewContextLevel,
  ReviewVerdict,
  ReviewVerdictInput,
  ReviewVerdictResult,
} from './review/verdict.js';
export { computeReviewVerdict, DETERMINISTIC_CHECKERS } from './review/verdict.js';

// Review floor (#1721)
export type {
  ReviewClass,
  ReviewFloorFiredRule,
  ReviewFloorInput,
  ReviewFloorPathChange,
  ReviewFloorPathRule,
  ReviewFloorResult,
  ReviewFloorRuleSet,
} from './review/floor.js';
export { computeReviewFloor, DEFAULT_REVIEW_FLOOR_RULES } from './review/floor.js';

export * from './review/risk.js'; // Risk tier (#3380, #3381)
export * from './review/risk-receipt.js'; // Risk receipt (#3386)
export { listPrChangedFiles } from './run/ci-rework.js';
// PR classifier shadow verdict (#1725)
export type { PrClassificationRecord, PrClassifierClaim, PrShadowInput, PrShadowVerdict } from './review/classifier.js';
export {
  buildClassifierPrompt,
  changedPathsFromDiff,
  CLASSIFIER_PROMPT_VERSION,
  classifierPolicyVersion,
  classifyPrShadow,
  parseClassifierOutput,
  toClassificationRecord,
} from './review/classifier.js';

// PR classifier backtest (#1728)
export type {
  BacktestHandLabel,
  BacktestOutcomeLabel,
  BacktestPorts,
  BacktestRecord,
  BacktestResult,
} from './review/backtest.js';
export {
  backtestFileName,
  classifiedRecords,
  buildBacktestRecord,
  parseBacktestLabels,
  runClassifierBacktest,
  selectBacktestPrs,
} from './review/backtest.js';

// PR classifier routing (#1724)
export type { ReviewRouting } from './review/routing.js';
export { classifierGateReason, parseNumstat, readReviewFloorChanges, resolveReviewRouting } from './review/routing.js';

// Review fork-PR containment gate (#1684)
export type {
  ContainmentGatedReviewDeps,
  ReviewContainmentDecision,
  ReviewContainmentOptions,
  ReviewPullRequestRepos,
} from './review/containment.js';

// Contained fork-PR review (#1685)
export type { ContainedReviewDeps, ContainedReviewResult, ReviewInterruptSource } from './review/contained.js';
export { pullRequestHeadRef, runContainedReview } from './review/contained.js';
export {
  isCrossRepoPullRequest,
  isForkPullRequest,
  resolveReviewContainment,
  REVIEW_CONTAINED_FLAG_HELP,
  REVIEW_CONTAINMENT_REFUSED_EXIT_CODE,
  runContainmentGatedReview,
} from './review/containment.js';

// Cross-repo PR references + review constitution (#1673)
export type { PullRequestReference, PullRequestReferenceParse, ResolvedPullRequest } from './review/pr-reference.js';
export {
  describePullRequestAccessError,
  formatPullRequestReference,
  parsePullRequestReference,
  resolvePullRequestReference,
  REVIEW_ACCESS_ERROR_EXIT_CODE,
} from './review/pr-reference.js';
export type { ReviewConstitution, ReviewConstitutionSource } from './constitutions/index.js';
export {
  DEFAULT_CODE_CONSTITUTION,
  DEFAULT_REVIEW_CONSTITUTION,
  describeConstitutionSource,
  describeReviewConstitutionSource,
} from './constitutions/index.js';
export { listBuiltInCheckers, type BuiltInCheckerInfo } from './checkers/index.js';
export { findTemplateTokens, isTemplateToken } from './config/template-tokens.js';
export { lintFactoryConfig } from './config/config-lint.js';
export { findConfigSchemaErrors, type ConfigSchemaFinding } from './config/config-schema-lint.js';
export type { ConfigLintFinding, ConfigLintInput, ConfigLintResult, ConfigLintVerdict } from './config/config-lint.js';
export type { TemplateTokenFinding } from './config/template-tokens.js';
export { findUnknownConstitutionCheckers, formatUnknownCheckerMessage } from './checkers/constitution-preflight.js';
export type { UnknownConstitutionChecker } from './checkers/constitution-preflight.js';

// Readiness deep check (#1732)
export type { DecompositionOutput } from './readiness/decompose.js';
export { buildDecompositionPrompt, parseDecompositionOutput, publishDecomposition } from './readiness/decompose.js';
export {
  type Slice,
  type SlicePlan,
  type SlicePlanBuildResult,
  type SlicePlanParseResult,
  type SliceState,
  DEFAULT_MAX_SLICES,
  SLICE_CAP_CEILING,
  overCapReason,
  sliceCapExceeded,
  SLICE_PLAN_MARKER,
  currentSlice,
  markSliceMerged,
  nextStackSlice,
  parentRefForSlice,
  parseSlicePlanComment,
  renderSlicePlanComment,
  slicePlanFromDecomposition,
  stackSliceBranch,
  withSliceBranchCreated,
  withSliceState,
  withSlicesAffected,
  withSlicesNotBuilt,
} from './readiness/slice-plan.js';
export type {
  SliceMergeRecordResult,
  SlicePlanCommentLookup,
  SlicePlanUpsertResult,
} from './readiness/slice-plan-github.js';
export { findSlicePlanComment, recordSliceMerged, upsertSlicePlanComment } from './readiness/slice-plan-github.js';
export { resolveSliceGate, type SliceGateOutcome } from './readiness/slice-gate.js';
export * from './blockers/index.js';
export * from './events/tail.js';
export type { ReadinessGapCriterion, ReadinessGapReport } from './readiness/enrich.js';
export { buildReadinessGapPrompt, parseReadinessGapOutput } from './readiness/enrich.js';
export type { IssueRunState, RunStatus } from './types/index.js';
export * from './run/state.js';
export * from './run/steer.js';
export * from './kpis/steerability.js';
export { createStackSliceBranch } from './run/stack-slice-branch.js';
export { restackAfterSquashMerge, type StackRestackOptions, type StackRestackOutcome } from './run/stack-restack.js';
export {
  checkResumePath,
  configParkMessage,
  createCheckResumeStore,
  createPlanReuseStore,
  formatPreservedBuildMessage,
  issueBodyHash,
  planReusePath,
  preservedFixTarget,
} from './run/resume-context.js';
export type { CheckResumeRecord, CheckResumeStore, PlanReuseRecord, PlanReuseStore } from './run/resume-context.js';
// Pre-PLAN base health (#2339)
export { BASE_HEALTH_CHECKERS, checkBaseHealth, fetchRequiredChecksVerdict } from './checkers/base-health.js';
export type { BaseHealthOptions, BaseHealthResult, RequiredChecksVerdict } from './checkers/base-health.js';
// Codex ChatGPT session freshness for doctor (#2509)
export { codexChatgptSessionState, type CodexSessionState } from './utils/codex-config.js';

// Last run-time local_auth failure per agent, read by doctor (#2733)
export {
  localAuthAgentFor,
  localAuthCredentialPath,
  localAuthFailureSinceLogin,
  localAuthRecordPath,
  recordLocalAuthFailure,
} from './utils/local-auth-record.js';
export type { LocalAuthAgent, LocalAuthFailure } from './utils/local-auth-record.js';
export { syncLandBranch, type LandSyncOptions, type LandSyncResult } from './land/sync.js';
export { fetchHumanEventSourcesCached, runProducedPrOrMerge } from './kpis/sweep.js';
export type { AgentInvocation, TokenCoverage, TokenCoverageEntry } from './metrics/token-coverage.js';
export { agentInvocationsFromEvents, computeTokenCoverage } from './metrics/token-coverage.js';
