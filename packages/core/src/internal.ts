// packages/core/src/internal.ts — Implementation details consumed by the factory's
// own packages (cli, tui, root scripts). No stability guarantee: these exports may
// change or disappear without notice. See ADR-0004 for the public/internal split.

// Failure evidence carried on events
export type { EvidencePack, FailureOrigin, FailurePhase } from './types/index.js';

// Self-fix merge gate (#374)
export type { FilingPolicy } from './filing/policy.js';
export { isAutoMergeBlocked } from './filing/policy.js';

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
export type { OrphanContainer, ReapedContainer } from './hosted/orphans.js';
export { listOrphanContainers, reapOrphanContainers } from './hosted/orphans.js';

// Router
export { CliModelExecutor } from './router/index.js';

// Phase helpers
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
  LocalSmallStep,
  LocalSmallStepPlan,
} from './local-small/stepwise.js';
export { createLocalSmallDryRun } from './local-small/stepwise.js';

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
export type { LaneWorktreeReapResult } from './utils/index.js';
export {
  branchFor,
  branchPrefixSlug,
  cleanupWorktree,
  colorEnabled,
  defaultRemoteBase,
  ensureDir,
  escalationLine,
  formatEventLine,
  gitFetch,
  isEscalation,
  levelForType,
  logCost,
  logEvent,
  readCosts,
  reapLaneWorktree,
  setupWorktree,
  shellEscape,
  slugify,
} from './utils/index.js';
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
  MAX_LABEL_NAME_LENGTH,
  parseClaimExpiresLabel,
  PARKED_LABEL,
  planQueueMigration,
  QUEUED_LABEL,
  QUEUE_ORDER_LABEL_PREFIX,
  queueOrderLabel,
  queueLabelSpecs,
  readGithubQueueSnapshot,
} from './queue/github-queue.js';
export type { QueueEntry, QueueSnapshot, QueueSnapshotEntry } from './queue/index.js';

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
export type { GithubQueueBackendOptions, QueueBackend } from './queue/queue-backend.js';
export { createGithubQueueBackend } from './queue/queue-backend.js';

// Stale-claim reaping (#999, lease-based since #1500)
export type { ReleaseStaleClaimsOptions, StaleClaim, StaleClaimRelease } from './queue/stale-claims.js';
export { findStaleClaims, releaseStaleClaims } from './queue/stale-claims.js';

// Green-and-ready PR reporting (#1000)
export type {
  FindUnmergedGreenPrsOptions,
  GreenPrGitHubClient,
  OpenPullRequestSummary,
  UnmergedGreenPr,
} from './utils/green-prs.js';
export { createOctokitGreenPrClient, findUnmergedGreenPrs, owningIssueForPr } from './utils/green-prs.js';

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

export { createRunRuntime } from './daemon/run-runtime.js';
export { createShipExecutor } from './daemon/ship-executor.js';
