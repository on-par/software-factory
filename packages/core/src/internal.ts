// packages/core/src/internal.ts — Implementation details consumed by the factory's
// own packages (cli, tui, root scripts). No stability guarantee: these exports may
// change or disappear without notice. See ADR-0004 for the public/internal split.

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
  DEFAULT_INTERNAL_REPO,
  fileBug,
  findMatchingIssue,
  fingerprintMarker,
  renderBugBody,
  renderOccurrenceComment,
  resolveTargetRepo,
} from './filing/index.js';

// Filing policy: when to file, caps, and self-fix labeling (#374)
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
export { resolveFilingPolicy } from './config/index.js';
export type { EffectiveConfig } from './config/repo.js';
export { resolveEffectiveConfig } from './config/repo.js';
export { resolveExperimental, resolveLocalOnly, resolveBranchPrefix } from './config/index.js';

// Design artifact (#422)
export { DesignArtifactSchema, parseDesignArtifact, readDesignArtifact, renderDesignArtifact } from './design/index.js';

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
export type { DockerEngineOptions } from './hosted/docker.js';
export { createDockerEngine } from './hosted/docker.js';

// Router
export { CliModelExecutor } from './router/index.js';

// Phase helpers
export type { PlanPromptOpts } from './phases/plan.js';
export { buildPlanPrompt } from './phases/plan.js';

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
export type { MicroVmLifecycleOptions, WorktreeSandbox } from './utils/microvm.js';
export { createMicroVm, microVmName, removeMicroVm, worktreeSandboxFor } from './utils/microvm.js';
export type { FileLockOptions, SyncFileLockOptions } from './utils/lock.js';
export { withFileLock, withFileLockSync, withGitLock } from './utils/lock.js';
export type { RunLockHolder, RunLockOptions } from './utils/run-lock.js';
export { readRunLockHolder, RunLockHeldError, withRunLock } from './utils/run-lock.js';
export type {
  GcCandidate,
  GcHeadPrState,
  GcReason,
  GcReport,
  SweepDeps,
  WorktreeListEntry,
} from './utils/worktree-gc.js';
export {
  findCredentialFiles,
  formatGcReport,
  parseWorktreeList,
  scrubFile,
  sweepWorktrees,
  zeroFill,
} from './utils/worktree-gc.js';

// Daemon repo registry (~/.factory/registry.json) (#781)
export type {
  RepoRegistry,
  RepoRegistryEntry,
  RepoRegistryListing,
  RepoState,
  WriteRegistryOptions,
} from './daemon/registry.js';
export {
  defaultRegistryPath,
  dispatchableRepos,
  emptyRegistry,
  getRepo,
  listRepos,
  loadRegistry,
  upsertRepo,
  writeRegistry,
} from './daemon/registry.js';

// Daemon lane state resolution (#843)
export type { DaemonLaneContext } from './daemon/lane-context.js';
export { createDaemonLaneContext } from './daemon/lane-context.js';
export type { DaemonOrchestrator } from './daemon/run-repo.js';
export { runDaemonRepo } from './daemon/run-repo.js';

// Daemon control-plane HTTP server (#777)
export type { FactorydOptions, FactorydServer } from './daemon/factoryd-http.js';
export { createFactorydServer, DEFAULT_FACTORYD_PORT } from './daemon/factoryd-http.js';

// Daemon attach gate (#778)
export type {
  AttachFailureReason,
  AttachRepoDeps,
  AttachRepoRequest,
  AttachRepoResult,
} from './daemon/repos-attach.js';
export { attachRepo, parseRemoteSlug, readOriginUrl } from './daemon/repos-attach.js';

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
  createGithubQueue,
  createOctokitQueueClient,
  defaultClaimantId,
  IN_PROGRESS_LABEL,
  LANE_LABEL_PREFIX,
  laneLabel,
  MAX_LABEL_NAME_LENGTH,
  PARKED_LABEL,
  planQueueMigration,
  QUEUED_LABEL,
  QUEUE_ORDER_LABEL_PREFIX,
  queueOrderLabel,
  queueLabelSpecs,
} from './queue/github-queue.js';
export type { QueueEntry } from './queue/index.js';

// Stale-claim reaping (#999)
export type { ReleaseStaleClaimsOptions, StaleClaim, StaleClaimRelease } from './queue/stale-claims.js';
export { findStaleClaims, localClaimPid, releaseStaleClaims } from './queue/stale-claims.js';

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
export type { LocalUsageCoordinatorOptions } from './usage/local-coordinator.js';
export { createLocalUsageCoordinator } from './usage/local-coordinator.js';
export type { SelectUsageCoordinatorOptions } from './usage/select-coordinator.js';
export { selectUsageCoordinator } from './usage/select-coordinator.js';

// Local queue reprioritization audit records (#869)
export type { QueueReprioritizationRecord } from './types/index.js';
export type { QueueRationaleAuditor } from './queue/reprioritization-audit.js';
export { createQueueRationaleAuditor } from './queue/reprioritization-audit.js';

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
export { wrapCommandInSandbox } from './sandbox/index.js';
