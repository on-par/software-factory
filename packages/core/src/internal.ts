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
export * from './config/provider-order-exports.js';
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
export { resolveBaseHealthChecks, resolveBaselineCacheTtlHours, resolveHermeticGit } from './config/base-health.js';
export {
  resolveEffectiveConfig,
  resolveReviewFloorRules,
  resolveT1SampleRate,
  resolveTrustTier,
} from './config/repo.js';
export { resolveExperimental, resolveLocalOnly, resolveBranchPrefix, resolveHostMaxBuilds } from './config/index.js';
export { CHECKER_ENV_ALLOW_VAR, CHECKER_ENV_ALLOWLIST, checkerParentEnv } from './environment/checker-env.js';
export { evaluateLoadGuard, formatLoadHold, readHostLoad, type LoadGuardDecision } from './environment/load-guard.js';
export {
  BYTES_PER_GB,
  claimDiskAlert,
  createDiskGuard,
  DISK_ALERT_INTERVAL_MS,
  evaluateDiskGuard,
  formatDiskHold,
  hostDiskAlertFile,
  readDiskFree,
  type DiskGuard,
  type DiskGuardDecision,
  type DiskSample,
} from './environment/disk-guard.js';
export { resolveDiskGuard, type DiskGuardPolicy } from './config/disk-policy.js';
export { hostAgentJobsDir, hostBuildSlotsDir, listHostSlots, withHostAgentJobLease } from './environment/host-slots.js';
export { withHostBuildSlot, type HostAgentJobKind, type HostSlotStatus } from './environment/host-slots.js';
export { createRunSlotGate, withRunAndHostBuildSlot, type RunSlotGate } from './environment/run-slots.js';
export { FACTORY_RUNTIME_CONFIG_KEYS, resolveHostLoadGuard, resolveHostMaxAgentJobs } from './config/index.js';
export * from './queue/internal-exports.js';
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
export { CliModelExecutor, formatBreakerRemaining } from './router/index.js';

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
  OvernightPreflightResult,
  OvernightQueueDeps,
  OvernightStateItem,
} from './local-small/overnight.js';
export { runOvernightQueue } from './local-small/overnight.js';
export { createLocalSmallDryRun } from './local-small/stepwise.js';
// Eval internals
export { judgeSpec, median, runJudgeSamples, scoreSpec } from './eval/index.js';

// Usage internals
export { resolveRunUsageHarness, TRAILING_WINDOW_MS } from './usage/index.js';

// Utils
export * from './internal-ci.js';
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
export * from './utils/run-lock.js';
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
export { findWorktreeKeep, removeWorktreeKeep, upsertWorktreeKeep } from './worktree/worktree-keeps.js';
// Daemon repo registry (~/.factory/registry.json) (#781)
export { defaultRegistryPath, listRepos, loadRegistry } from './daemon/registry.js';
export { createGithubLaneClaimStalenessProbe, releaseLaneClaim } from './run/lane-file-guard.js';
export type { LaneClaimStalenessProbe, LaneFileHold } from './run/lane-file-guard.js';

// Daemon control-plane HTTP server (#777)
export { createFactorydServer, DEFAULT_FACTORYD_PORT } from './daemon/factoryd-http.js';

// Durable explicit daemon runs (#1393)
export { daemonRunFile, isValidRunId, readDaemonRun } from './daemon/run-store.js';

// Daemon runtime state: pid/port/log files under ~/.factory (#1177)
export {
  acquirePidFile,
  createDaemonLogSink,
  daemonRuntimePaths,
  releaseRuntimeFiles,
  writePortFile,
} from './daemon/runtime-state.js';

// Daemon attach gate (#778)
export { parseRemoteSlug } from './daemon/repos-attach.js';

// GitHub-label-backed work queue (#824)
export type {
  EnqueueResult,
  GithubQueue,
  QueueClaim,
  QueueClearPreview,
  QueueClearResult,
  QueueGitHubClient,
  QueueIssue,
  QueuePreflightDecision,
  QueueReleaseOutcome,
} from './queue/github-queue.js';
export {
  CLAIM_EXPIRES_LABEL_PREFIX,
  createGithubQueue,
  createOctokitQueueClient,
  defaultClaimantId,
  DEFAULT_CLAIM_LEASE_MS,
  IN_PROGRESS_LABEL,
  LANE_LABEL_PREFIX,
  laneLabel,
  laneSlug,
  PARKED_LABEL,
  planQueueMigration,
  QUEUED_LABEL,
  QUEUE_ORDER_LABEL_PREFIX,
  queueOrderLabel,
  readGithubQueueSnapshot,
} from './queue/github-queue.js';
export type { QueueSnapshot } from './queue/index.js';
export { formatQueueOrderConflict, type QueueOrderConflict } from './queue/queue-order.js';

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

// Stale-claim reaping (#999, lease-based since #1500)
export { releaseStaleClaims } from './queue/stale-claims.js';
export { unqueueDeferredOnly } from './queue/deferred-only.js';
export type { StatelessLaneIssue } from './queue/stateless-lane.js';
export { listStatelessLaneIssues } from './queue/stateless-lane.js';
export { runUnpark, UnparkError } from './queue/unpark.js';
export type { OrderCollision, UnparkInput, UnparkJson } from './queue/unpark.js';
export { sweepOrphanDrafts } from './queue/orphan-drafts.js';
export { resolveQueueClaimSettleMs } from './queue/claim-settle.js';
export { DEFAULT_MAX_CLOCK_SKEW_MS, measureGithubClockSkew, resolveQueueMaxClockSkewMs } from './queue/clock-skew.js';
// Green-and-ready PR reporting (#1000)
export type {
  FindUnmergedGreenPrsOptions,
  GreenPrGitHubClient,
  OpenPullRequestSummary,
  UnmergedGreenPr,
} from './utils/green-prs.js';
export { createOctokitGreenPrClient, findUnmergedGreenPrs, owningIssueForPr } from './utils/green-prs.js';

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

// Local queue reprioritization audit records (#869)
export type { QueueReprioritizationRecord } from './types/index.js';

// Publish only coarse daemon lifecycle status to configured ProjectV2 items (#868)
export type { ProjectStatusWriter, ProjectStatusWriterOptions } from './projects/project-status-writer.js';
export { createProjectStatusWriter } from './projects/project-status-writer.js';

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
export { settleParkedPullRequest, type ParkedPrDisposition } from './run/park-pr.js';
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
export { parkPayload, parkUnblockHint, publishParkComment, readParkedOrder } from './run/park-comment.js';
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
export * from './checkers/internal-exports.js';
export { findTemplateTokens, isTemplateToken, type TemplateTokenFinding } from './config/template-tokens.js';
export { findUnknownConfigKeyWarnings, lintFactoryConfig } from './config/config-lint.js';
export { findConfigSchemaErrors, type ConfigSchemaFinding } from './config/config-schema-lint.js';
export type { ConfigLintFinding, ConfigLintInput, ConfigLintResult, ConfigLintVerdict } from './config/config-lint.js';
export { findUnknownConstitutionCheckers, formatUnknownCheckerMessage } from './checkers/constitution-preflight.js';
export type { UnknownConstitutionChecker } from './checkers/constitution-preflight.js';
// Readiness deep check (#1732)
export type { DecompositionOutput } from './readiness/decompose.js';
export * from './readiness/parent-coverage.js';
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
export * from './readiness/internal-exports.js';
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
export { BaselineCache } from './checkers/baseline-cache.js';
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
export { syncLandBranch } from './land/sync.js';
export { fetchHumanEventSourcesCached, runProducedPrOrMerge } from './kpis/sweep.js';
export type { AgentInvocation, TokenCoverage, TokenCoverageEntry } from './metrics/token-coverage.js';
export { agentInvocationsFromEvents, computeTokenCoverage } from './metrics/token-coverage.js';
export { partitionGithubClaimsByActivity } from './queue/activity.js';
export * from './utils/open-factory-drafts.js';
