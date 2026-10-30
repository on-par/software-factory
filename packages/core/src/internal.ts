// packages/core/src/internal.ts — Implementation details consumed by the factory's
// own packages (cli, tui, root scripts). No stability guarantee: these exports may
// change or disappear without notice. See ADR-0004 for the public/internal split.
// Garden harvest (#2083)
export type { GardenCluster } from './garden/harvest.js';
export {
  DEFAULT_GARDEN_MAX_CLUSTERS,
  DEFAULT_GARDEN_SINCE,
  capGardenClusters,
  clusterGarden,
  filterGardenWindow,
  parseGardenDuration,
  readHarvestEvents,
  renderGardenJson,
  renderGardenReport,
} from './garden/harvest.js';
// Garden dedup (#2102)
export { dedupGardenClusters, filterGardenOnlyNew, markGardenTrackingUnknown } from './garden/dedup.js';
// Failure fingerprint & evidence
export type { FingerprintedFailure } from './types/index.js';
export * from './config/provider-order-exports.js';
// Auto-file a fingerprinted bug (#373)
export type { FileBugResult, FilingGitHubClient } from './filing/index.js';
export { createOctokitFilingClient, DEFAULT_BUG_LABELS, fileBug } from './filing/index.js';

// Evidence sanitizer for untrusted text (#1841, #1852)
export { stripHiddenContent } from './filing/sanitize.js';

// Redacted upstream factory report (#1858)
export { buildUpstreamReport, upstreamInputFromEvidence } from './filing/upstream.js';
export { isAutoMergeBlocked } from './filing/policy.js';
// Config
export { resolveStateRoot, STATE_ROOT_ENV } from './config/state-root.js';
export { resolveFilingPolicy, resolvePrClassifierPolicy } from './config/index.js';
export { aliasDeprecatedSizeGateMode, isExplicitStackMode } from './config/index.js';
export { describeDraftPrPolicy, resolveDraftPrPolicy } from './config/run-section.js';
export type { TrustTier } from './config/repo.js';
export { resolveBaseHealthChecks, resolveBaselineCacheTtlHours, resolveHermeticGit } from './config/base-health.js';
export {
  resolveEffectiveConfig,
  resolveReviewFloorRules,
  resolveT1SampleRate,
  resolveTrustTier,
} from './config/repo.js';
export { resolveExperimental, resolveLocalOnly, resolveBranchPrefix, resolveHostMaxBuilds } from './config/index.js';
export { evaluateLoadGuard, formatLoadHold, readHostLoad, type LoadGuardDecision } from './environment/load-guard.js';
export {
  claimDiskAlert,
  createDiskGuard,
  formatDiskHold,
  hostDiskAlertFile,
  type DiskGuard,
  type DiskGuardDecision,
} from './environment/disk-guard.js';
export { hostAgentJobsDir, hostBuildSlotsDir, listHostSlots, withHostAgentJobLease } from './environment/host-slots.js';
export { type HostAgentJobKind, type HostSlotStatus } from './environment/host-slots.js';
export { createRunSlotGate, withRunAndHostBuildSlot, type RunSlotGate } from './environment/run-slots.js';
export { FACTORY_RUNTIME_CONFIG_KEYS, resolveHostLoadGuard, resolveHostMaxAgentJobs } from './config/index.js';
export * from './queue/internal-exports.js';
export {
  migrateRepoConfigToYaml,
  REPO_CONFIG_YAML_HEADER,
  readRepoConfigFile,
  resolveRepoConfigPath,
  rewriteRepoConfigFile,
  setRepoConfigValue,
} from './config/repo-config-file.js';
export type { RepoConfigYamlMigration } from './config/repo-config-file.js';
export { renderConfigExample } from './config/example.js';
export { resolveEvidenceAllowlist, type EvidenceAllowlist } from './checkers/evidence-allowlist.js';
export { runEvidencePlan, type EvidencePlanResult, type EvidenceRunnerContext } from './checkers/evidence-plan.js';
// Concrete coding harnesses
export { classifyFailure } from './harness/classify.js';
export { type HarnessCheckResult, runHarnessCheck } from './harness/check.js';
export { classifyOpenCodeErrorType, parseOpenCodeJson } from './harness/opencode.js';
export * as openCodeVersion from './harness/opencode-version.js';
export { createDockerEngine } from './hosted/docker.js';
export { listOrphanContainers, reapOrphanContainers } from './hosted/orphans.js';
// Router
export { harnessCliCommand } from './harness/catalog.js';
export { isHarnessCliPresent } from './models/index.js';
export { formatBreakerRemaining } from './router/index.js';

// Phase helpers
export { buildTriagePrompt, normalizeTriageQueue, parseTriageCandidates } from './triage/index.js';
export { dropQueuedIssues, parseOpenPrIssues } from './triage/index.js';

// Board-constrained local lane dispatch (#848)

// ProjectV2 queue-intent scheduler (#867)

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
export { median } from './eval/index.js';

// Usage internals
export { resolveRunUsageHarness, TRAILING_WINDOW_MS } from './usage/index.js';

// Utils
export * from './internal-ci.js';
export { runCommand } from './utils/command-runner.js';
export type { CoverageMetrics } from './utils/coverage-ratchet.js';
export {
  checkScopedRatchetDrift,
  DEFAULT_RATCHET_SLACK,
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
  formatEventLine,
  getIssueTitle,
  gitFetch,
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
export { formatStopMarker, readStopMarker, type StopMarker } from './utils/stop-marker.js';
export { hasOpencodeLoginEvidence } from './utils/opencode-config.js';
export type { WorktreeSandbox } from './utils/microvm.js';
export { listMicroVms, microVmName, reapOrphanMicroVm, worktreeSandboxFor } from './utils/microvm.js';
export { withFileLock, withGitLock } from './utils/lock.js';
export {
  RunLockHeldError,
  type RunLockScope,
  runLockDirFor,
  listLiveRunLocks,
  withScopedRunLock,
} from './utils/run-lock.js';
export { formatWorktreeLocation, laneWorktreePath, resolveWorktreeRoot } from './utils/worktree-location.js';
export {
  countUnpushedCommits,
  formatGcReport,
  isWorktreeClean,
  parseWorktreeList,
  sweepWorktrees,
} from './worktree/worktree-gc.js';
export { findWorktreeKeep, removeWorktreeKeep, upsertWorktreeKeep } from './worktree/worktree-keeps.js';
// Daemon repo registry (~/.factory/registry.json) (#781)
export { defaultRegistryPath, listRepos, loadRegistry } from './daemon/registry.js';
export { createGithubLaneClaimStalenessProbe, releaseLaneClaim } from './run/lane-file-guard.js';

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
export type { AdmissionLookup, AdmissionStateReader, QueueCompatibilityVerdict } from './admission/index.js';
export {
  classifyQueueCompatibility,
  createFileAdmissionStateReader,
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
export type { UnmergedGreenPr } from './utils/green-prs.js';
export { createOctokitGreenPrClient, findUnmergedGreenPrs } from './utils/green-prs.js';

// Sandbox command wrapping — used by the CLI's doctor probe (#1008)
export { wrapCommandInSandbox, shouldProxyEgress, isEgressEnforced } from './sandbox/index.js';
export { resolveConfiguredWritablePaths } from './sandbox/writable-paths.js';
export { startEgressProxy, egressSummaryMessage, egressHostMessage } from './sandbox/egress-proxy.js';
export { createRunRuntime, type RunRuntime } from './daemon/run-runtime.js';
export { findOpenPR } from './phases/ship.js';
export { settleParkedPullRequest } from './run/park-pr.js';
export { findAdoptablePr, lookupOpenPrByIssue, lookupOpenPrByBranch, type OpenPrLookup } from './run/adopt-pr.js'; // findAdoptablePr + the shared open-PR lookup (#3439)
export { readStackSliceGate } from './phases/stack-approval.js';
export type { StackPullReviews } from './phases/stack-approval.js';
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
export { isTemplateToken } from './config/template-tokens.js';
export {
  findCodexSandboxWarnings,
  findSizeGateWarnings,
  findUnknownConfigKeyWarnings,
  lintFactoryConfig,
} from './config/config-lint.js';
export { findConfigSchemaErrors } from './config/config-schema-lint.js';
export type { ConfigLintInput } from './config/config-lint.js';
export { findUnknownConstitutionCheckers, formatUnknownCheckerMessage } from './checkers/constitution-preflight.js';
export type { UnknownConstitutionChecker } from './checkers/constitution-preflight.js';
// Readiness deep check (#1732)
export { buildDecompositionPrompt, parseDecompositionOutput } from './readiness/decompose.js';
export {
  type SlicePlan,
  currentSlice,
  nextStackSlice,
  renderSlicePlanComment,
  withSliceState,
} from './readiness/slice-plan.js';
export type { SlicePlanCommentLookup } from './readiness/slice-plan-github.js';
export { findSlicePlanComment, recordSliceMerged, upsertSlicePlanComment } from './readiness/slice-plan-github.js';
export type { SlicePlanStore } from './readiness/slice-plan-store.js';
export { fileSlicePlanStore } from './readiness/slice-plan-store.js';
export { findDeclaredPrerequisites, createOctokitBlockedParkStore, pollBlockedParks } from './blockers/index.js';
export {
  eventSegmentsDir,
  eventSegmentFileName,
  listEventSegmentPaths,
  readEventsTail,
  readEventsSince,
  InvalidEventCursorError,
} from './events/tail.js';
export * from './readiness/internal-exports.js';
export type { IssueRunState, RunStatus } from './types/index.js';
export {
  runStateFile,
  writeIssueRunState,
  readIssueRunState,
  listIssueRuns,
  nextIssueRunState,
  type RunStateUpdate,
  type IssueRunStateBase,
} from './run/state.js';
export {
  appendSteerEvent,
  SteerEventError,
  STEER_SOURCES,
  STEER_PHASES,
  type SteerSource,
  type SteerPhase,
  type SteerEvent,
} from './run/steer.js';
export {
  collectMergedPrSteers,
  summarizeSteerability,
  formatSteerabilityReport,
  type SteerabilityReport,
} from './kpis/steerability.js';
export { restackAfterSquashMerge, type StackRestackOutcome } from './run/stack-restack.js';
export { createCheckResumeStore, createPlanReuseStore } from './run/resume-context.js';
export type { CheckResumeRecord, CheckResumeStore, PlanReuseRecord, PlanReuseStore } from './run/resume-context.js';
// Pre-PLAN base health (#2339)
export { BaselineCache } from './checkers/baseline-cache.js';
export { BASE_HEALTH_CHECKERS, checkBaseHealth, fetchRequiredChecksVerdict } from './checkers/base-health.js';
export type { BaseHealthOptions, BaseHealthResult, RequiredChecksVerdict } from './checkers/base-health.js';
// Codex ChatGPT session freshness for doctor (#2509)
export { codexChatgptSessionState } from './utils/codex-config.js';

// Last run-time local_auth failure per agent, read by doctor (#2733)
export { localAuthFailureSinceLogin, recordLocalAuthFailure } from './utils/local-auth-record.js';
export { syncLandBranch } from './land/sync.js';
export { fetchHumanEventSourcesCached, runProducedPrOrMerge } from './kpis/sweep.js';
export { partitionGithubClaimsByActivity } from './queue/activity.js';
export {
  type OpenFactoryDrafts,
  readOpenFactoryDrafts,
  formatOpenFactoryDraftsLine,
} from './utils/open-factory-drafts.js';

export { listBlockedBy, type BlockedByItem } from './blockers/dependencies.js';
