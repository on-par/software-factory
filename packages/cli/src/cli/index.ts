import { fileURLToPath } from 'node:url';
// packages/cli/src/cli/index.ts — CLI entry point: factory <command> [options]

import { exec as execCb, execSync, type StdioOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { arch, hostname as osHostname, release, platform, userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify, styleText } from 'node:util';

import type { Octokit } from '@octokit/rest';
import type {
  Environment,
  EnvironmentProxySettings,
  EventKind,
  FactoryConfig,
  FactoryEvent,
  GithubIssueParams,
  HealthKpis,
  IngestSettings,
  KpiHistoryRecord,
  KpiReconstruction,
  LaneProxy,
  LeaseHealth,
  LocalBriefParams,
  LocalOnlyPolicy,
  DoctorProbes,
  ModelDiagnosis,
  PrSource,
  LanePausedPayload,
  ParkReason,
  QueueDiagnostic,
  ReapedLease,
  RepoFactoryConfig,
  RunOutcome,
  RunPorts,
  SandboxRuntime,
  UsageReading,
  WatchdogPolicyOverrides,
  WatchdogPolicySource,
  WorkRequest,
} from '@on-par/factory-core';
import { INVALID_BRANCH_PREFIX_MESSAGE, resolveBranchPrefixOption } from './branch-prefix.js';
import {
  acquirePortLease,
  aggregateCosts,
  appendKpiHistoryLine,
  applyRepoConfig,
  buildPhase,
  checkPhase,
  clearProxyState,
  computeHealthKpis,
  ConstitutionLoader,
  createDefaultWorkSourceRegistry,
  createLogger,
  createLaneProxy,
  defaultFindPortListeners,
  describeEffectiveConfig,
  detectPostMergeDefects,
  diagnoseModels,
  probeDeclaredHarnesses,
  estimateTrailingSpend,
  fetchDefectSources,
  fetchHumanEventSources,
  fetchSubscriptionUsage,
  formatUsageReport,
  getConstitutionsDir,
  getFactoryPaths,
  GITHUB_ISSUE_SOURCE,
  hasUnresolvedPark,
  InvalidArtifactsDirError,
  InvalidWorkRequestInputError,
  InvalidWorkspaceError,
  isCommandAvailable,
  isProxyRunning,
  kpiBranchPrefixes,
  kpisToHistoryRecord,
  laneBaseUrl,
  laneEnv,
  laneHostLabel,
  loadFactoryConfigForRepo,
  loadModelsConfig,
  loadRepoConfig,
  loadRoutesConfig,
  LOCAL_BRIEF_SOURCE,
  joinClassifierOutcomes,
  mergeClassifierOutcomes,
  parseClassifierOutcomes,
  summarizeClassifierOutcomes,
  formatClassifierReport,
  mergedPrRefs,
  ModelRegistry,
  ModelRouter,
  parkReasonFor,
  parseKpiHistory,
  parseQueue,
  planPhase,
  provisionLaneContainer,
  readEvents,
  readPortLeases,
  readQueue,
  readUsage,
  reapOrphanProcesses,
  reconstructKpiEvents,
  recordLeasePgid,
  releasePortLease,
  renderKpiReport,
  renderKpiTrend,
  resolveCodexDisabled,
  resolveDefectWindowDays,
  resolveSizeGateMode,
  parseSizeGateMode,
  parseMaxSlices,
  SIZE_GATE_MODES,
  type SizeGateMode,
  resolveEffectiveBuildRoute,
  resolveEffectiveModelPins,
  resolveLaneBreakerThreshold,
  resolveEnvironmentProxy,
  resolveArtifactsDir,
  resolveLocalOnlyPolicy,
  resolveMergePolicy,
  resolveSandboxPolicy,
  resolveSkipCI,
  resolveTimeouts,
  resolveUsageCap,
  resolveWatchdogPolicy,
  runAutoIngest,
  shipPhase,
  formatCostTotal,
  validateQueue,
  watchUsage,
  writeLocalRunReport,
  writeProxyState,
} from '@on-par/factory-core';
import type {
  CiOutcome,
  EnqueueResult,
  GardenCluster,
  GithubQueue,
  OvernightItemOutcome,
  OvernightPreflightResult,
  OvernightQueueDeps,
  OvernightStateItem,
  QueueClaim,
  QueueIssue,
  QueuePreflightDecision,
  QueueReleaseOutcome,
  RepoConfigYamlMigration,
  SlicePlan,
  SlicePlanCommentLookup,
  UnmergedGreenPr,
  WorktreeSandbox,
} from '@on-par/factory-core/internal';
import {
  acquirePidFile,
  createCheckResumeStore,
  findSlicePlanComment,
  recordSliceMerged,
  upsertSlicePlanComment,
  withSliceState,
  DEFAULT_GARDEN_MAX_CLUSTERS,
  DEFAULT_GARDEN_SINCE,
  capGardenClusters,
  clusterGarden,
  dedupGardenClusters,
  filterGardenOnlyNew,
  filterGardenWindow,
  markGardenTrackingUnknown,
  parseGardenDuration,
  readHarvestEvents,
  renderGardenJson,
  renderGardenReport,
  laneWorktreePath,
  migrateRepoConfigToYaml,
  REPO_CONFIG_YAML_HEADER,
  claudeConfigDirOverride,
  claudeKeychainService,
  cleanupWorktree,
  createDaemonLogSink,
  factoryBranchIssue,
  factoryBranchPrefixes,
  createDockerEngine,
  createFactorydServer,
  createRunRuntime,
  createShipExecutor,
  createGithubQueue,
  createLocalSmallDryRun,
  createOctokitFilingClient,
  createOctokitGreenPrClient,
  createOctokitQueueClient,
  daemonRuntimePaths,
  defaultRegistryPath,
  ensureDir,
  FACTORY_RUNTIME_CONFIG_KEYS,
  findUnmergedGreenPrs,
  formatGcReport,
  gitFetch,
  listMicroVms,
  listOrphanContainers,
  logCost,
  logEvent,
  planQueueMigration,
  readCosts,
  readGithubQueueSnapshot,
  reapLaneWorktree,
  reapOrphanContainers,
  reapOrphanMicroVm,
  releaseRuntimeFiles,
  releaseStaleClaims,
  resolveBranchPrefix,
  resolveEffectiveConfig,
  worktreeSandboxFor,
  resolveExperimental,
  resolveLocalOnly,
  resolvePrClassifierPolicy,
  resolveRunUsageHarness,
  resolveReviewFloorRules,
  RunLockHeldError,
  runOvernightQueue,
  parseRemoteSlug,
  setupWorktree,
  shellEscape,
  listBuiltInCheckers,
  slugify,
  sweepWorktrees,
  watchChecks,
  withAdmissionGuard,
  withFileLock,
  withGitLock,
  withRunLock,
  writePortFile,
  buildTriagePrompt,
  normalizeTriageQueue,
  parseTriageCandidates,
  recordLocalAuthFailure,
} from '@on-par/factory-core/internal';
import { type QueueReader, runTui } from '@on-par/factory-tui';
import { admissionStateReaderFor, runQueueReconcile } from './admission.js';
import {
  cmdClassifierBacktest,
  ClassifierBacktestInputError,
  type ClassifierBacktestOptions,
} from './classifier-backtest.js';
import { findOpenPRForIssue, landIssue, waitForMerge } from './land.js';
import {
  AwaitingReviewError,
  CiFailedError,
  CiUnverifiedError,
  getPullRequestLandState,
  LandConflictError,
  LandFailureError,
  MergeGatedError,
} from './land-pr.js';
import { setLandRuntime } from './land-runtime.js';
import { shipIssue } from './ship.js';
import { cmdStatus, type StatusOptions } from './status.js';
import { cmdSupervise, type SuperviseOptions } from './supervise.js';
import { setShipRuntime } from './ship-runtime.js';
import { runQueueClear } from './queue-clear.js';
import { buildProgram } from './program.js';
import { buildCostJson } from './cost-json.js';
import { buildQueueAddJson } from './queue-add-json.js';
import { buildQueueListJson } from './queue-list.js';
import { runUnpark, UnparkError, type UnparkJson } from './unpark.js';
import { buildRunsJson, parseRunsLimit } from './runs.js';
import { buildRunDiffstatJson, NoRunError, parseDiffstatIssue, type RunDiffstatJson } from './runs-diffstat.js';
import {
  formatUpdateStartupLine,
  initialUpdateState,
  readUpdateState,
  updateStatePath,
  writeUpdateState,
} from './update-state.js';
import { buildStopResumeJson } from './stop-resume-json.js';
import { buildUsageJson } from './usage-json.js';
import { parseResetIssues, runReset } from './reset.js';
import {
  cmdDaemonLogs,
  cmdDaemonStart,
  cmdDaemonStatus,
  cmdDaemonStop,
  createAutoUpdateDeps,
  DaemonCtlError,
  detectInstall,
  loadDaemonFileConfig,
  recoverStaleDrain,
  resolveFactorydConfig,
  runAutoUpdateLoop,
  type DaemonCtlDeps,
  type FactorydConfig,
} from './daemon.js';
import { checkForUpdate, cmdSelfUpdateCheck, type SelfUpdateDeps } from './self-update.js';
import { cmdDoctor, keychainPreflightError, type KeychainProbeStatus } from './doctor.js';
import type { GreenPrScanResult, LeaseHealthRow, UnmergedGreenPrRow } from './doctor-health.js';
import {
  DOCS_URL,
  formatOverview,
  availableAgentClis,
  missingAgentCliMessage,
  missingTokenMessage,
  notInitializedMessage,
} from './first-run.js';
import { cmdHostedSmoke } from './hosted.js';
import { cmdHostedQueue } from './hosted-queue.js';
import { cmdHostedRunner } from './hosted-runner.js';
import { resolveFactoryCheckoutCommit, runFilingPreview } from './filing.js';
import { buildFeedbackDeps, type FeedbackDeps, resolveFeedbackRepo, runFeedback } from './feedback.js';
import { ensureFactoryExcluded, writeSampleQueue } from './init-files.js';
import { cmdLogs } from './logs.js';
import { mergeScopeNotice } from './merge-scope.js';
import { selectOctokit } from './github-stub.js';
import { createFactoryOctokit, type FactoryOctokitOptions } from './octokit.js';
import { DeepCheckError, createDeepModelRunner, runIssueCheck, type DeepCheckModelRunner } from './ready-check.js';
import { childRunSucceeded, formatChildRunSummary, runChildrenInOrder, type ChildRunResult } from './run-children.js';
import { type BaseHoldDecision, createBaseHoldGate, formatBaseHoldCleared, writeBaseHold } from './base-hold.js';
import { readRunFlagOverrides, writeRunFlagOverrides } from './run-flags.js';
import { runStalenessGuard } from './staleness.js';
import { readStopFileStatus, stopSentinelRunSkipMessage } from './stop-sentinel.js';

export type ConfigLoaderKey =
  | 'loadModelsConfig'
  | 'loadRoutesConfig'
  | 'loadFactoryConfigForRepo'
  | 'loadRepoConfig'
  | 'resolveTimeouts'
  | 'resolveSkipCI'
  | 'getConstitutionsDir'
  | 'resolveEffectiveModelPins';
type ConfigLoaders = Required<Pick<CliDeps, ConfigLoaderKey>>;

const DEFAULT_CONFIG_LOADERS: ConfigLoaders = {
  loadModelsConfig,
  loadRoutesConfig,
  loadFactoryConfigForRepo,
  loadRepoConfig,
  resolveTimeouts,
  resolveSkipCI,
  getConstitutionsDir,
  resolveEffectiveModelPins,
};

/** Loaders for the current main() invocation; DEFAULT_CONFIG_LOADERS outside main(). */
let configLoaders: ConfigLoaders = DEFAULT_CONFIG_LOADERS;

/** Per-field `??` so an explicit `undefined` override falls back instead of replacing the default. */
/** Display path for the repo config file in preflight messages: repo-relative, or absolute when the state root lives outside the repo (#2586). */
function repoConfigFileFor(repoRoot: string, absPath: string): { absPath: string; relPath: string } {
  const rel = relative(repoRoot, absPath);
  return { absPath, relPath: rel === '' || rel.startsWith('..') || isAbsolute(rel) ? absPath : rel };
}

function resolveConfigLoaders(overrides: Partial<ConfigLoaders>, base: ConfigLoaders = configLoaders): ConfigLoaders {
  return {
    loadModelsConfig: overrides.loadModelsConfig ?? base.loadModelsConfig,
    loadRoutesConfig: overrides.loadRoutesConfig ?? base.loadRoutesConfig,
    loadFactoryConfigForRepo: overrides.loadFactoryConfigForRepo ?? base.loadFactoryConfigForRepo,
    loadRepoConfig: overrides.loadRepoConfig ?? base.loadRepoConfig,
    resolveTimeouts: overrides.resolveTimeouts ?? base.resolveTimeouts,
    resolveSkipCI: overrides.resolveSkipCI ?? base.resolveSkipCI,
    getConstitutionsDir: overrides.getConstitutionsDir ?? base.getConstitutionsDir,
    resolveEffectiveModelPins: overrides.resolveEffectiveModelPins ?? base.resolveEffectiveModelPins,
  };
}

export type GitOpKey = 'setupWorktree' | 'cleanupWorktree' | 'gitFetch';
type GitOps = Required<Pick<CliDeps, GitOpKey>>;

const DEFAULT_GIT_OPS: GitOps = { setupWorktree, cleanupWorktree, gitFetch };

/** Git worktree/fetch ops for the current main() or cmdLand invocation; DEFAULT_GIT_OPS outside them. */
let gitOps: GitOps = DEFAULT_GIT_OPS;

/** Per-field `??` so an explicit `undefined` override falls back instead of replacing the default. */
function resolveGitOps(overrides: Partial<GitOps>, base: GitOps = gitOps): GitOps {
  return {
    setupWorktree: overrides.setupWorktree ?? base.setupWorktree,
    cleanupWorktree: overrides.cleanupWorktree ?? base.cleanupWorktree,
    gitFetch: overrides.gitFetch ?? base.gitFetch,
  };
}

export type InternalOpKey =
  | 'watchChecks'
  | 'createLocalSmallDryRun'
  | 'readCosts'
  | 'sweepWorktrees'
  | 'releaseStaleClaims'
  | 'findUnmergedGreenPrs'
  | 'listOrphanContainers'
  | 'reapOrphanContainers'
  | 'listMicroVms'
  | 'reapOrphanMicroVm'
  | 'formatGcReport';
type InternalOps = Required<Pick<CliDeps, InternalOpKey>>;

const DEFAULT_INTERNAL_OPS: InternalOps = {
  watchChecks,
  createLocalSmallDryRun,
  readCosts,
  sweepWorktrees,
  releaseStaleClaims,
  findUnmergedGreenPrs,
  listOrphanContainers,
  reapOrphanContainers,
  listMicroVms,
  reapOrphanMicroVm,
  formatGcReport,
};

/** factory-core/internal ops for the current main() or cmdLand invocation; DEFAULT_INTERNAL_OPS outside them. */
let internalOps: InternalOps = DEFAULT_INTERNAL_OPS;

/** Per-field `??` so an explicit `undefined` override falls back instead of replacing the default. */
function resolveInternalOps(overrides: Partial<InternalOps>, base: InternalOps = internalOps): InternalOps {
  return {
    watchChecks: overrides.watchChecks ?? base.watchChecks,
    createLocalSmallDryRun: overrides.createLocalSmallDryRun ?? base.createLocalSmallDryRun,
    readCosts: overrides.readCosts ?? base.readCosts,
    sweepWorktrees: overrides.sweepWorktrees ?? base.sweepWorktrees,
    releaseStaleClaims: overrides.releaseStaleClaims ?? base.releaseStaleClaims,
    findUnmergedGreenPrs: overrides.findUnmergedGreenPrs ?? base.findUnmergedGreenPrs,
    listOrphanContainers: overrides.listOrphanContainers ?? base.listOrphanContainers,
    reapOrphanContainers: overrides.reapOrphanContainers ?? base.reapOrphanContainers,
    listMicroVms: overrides.listMicroVms ?? base.listMicroVms,
    reapOrphanMicroVm: overrides.reapOrphanMicroVm ?? base.reapOrphanMicroVm,
    formatGcReport: overrides.formatGcReport ?? base.formatGcReport,
  };
}

export type ShellExec = (
  command: string,
  options?: { cwd?: string; timeout?: number },
) => Promise<{ stdout: string; stderr: string }>;
export type ShellExecSync = (
  command: string,
  options?: { timeout?: number; stdio?: StdioOptions; env?: NodeJS.ProcessEnv },
) => string;

export type ShellOpKey = 'exec' | 'execSync';
type ShellOps = Required<Pick<CliDeps, ShellOpKey>>;

const promisifiedExec = promisify(execCb);
const DEFAULT_SHELL_OPS: ShellOps = {
  exec: async (command, options) => {
    const { stdout, stderr } = await promisifiedExec(command, { ...options, encoding: 'utf-8' });
    return { stdout, stderr };
  },
  execSync: (command, options) => String(execSync(command, { ...options, encoding: 'utf-8' })),
};

/** Shell exec seams for the current main() or cmdLand invocation; DEFAULT_SHELL_OPS outside them. */
let shellOps: ShellOps = DEFAULT_SHELL_OPS;

/** Per-field `??` so an explicit `undefined` override falls back instead of replacing the default. */
function resolveShellOps(overrides: Partial<ShellOps>, base: ShellOps = shellOps): ShellOps {
  return {
    exec: overrides.exec ?? base.exec,
    execSync: overrides.execSync ?? base.execSync,
  };
}

export type CoreOpKey =
  | 'ModelRouter'
  | 'ConstitutionLoader'
  | 'ModelRegistry'
  | 'isCommandAvailable'
  | 'defaultFindPortListeners'
  | 'reapOrphanProcesses'
  | 'estimateTrailingSpend'
  | 'formatUsageReport'
  | 'watchUsage'
  | 'fetchSubscriptionUsage'
  | 'diagnoseModels'
  | 'probeDeclaredHarnesses'
  | 'writeLocalRunReport';
type CoreOps = Required<Pick<CliDeps, CoreOpKey>>;

const DEFAULT_CORE_OPS: CoreOps = {
  ModelRouter,
  ConstitutionLoader,
  ModelRegistry,
  isCommandAvailable,
  defaultFindPortListeners,
  reapOrphanProcesses,
  estimateTrailingSpend,
  formatUsageReport,
  watchUsage,
  fetchSubscriptionUsage,
  diagnoseModels,
  probeDeclaredHarnesses,
  writeLocalRunReport,
};

/** factory-core classes/ops for the current main() invocation; DEFAULT_CORE_OPS outside it. */
let coreOps: CoreOps = DEFAULT_CORE_OPS;

/** Per-field `??` so an explicit `undefined` override falls back instead of replacing the default. */
function resolveCoreOps(overrides: Partial<CoreOps>, base: CoreOps = coreOps): CoreOps {
  return {
    ModelRouter: overrides.ModelRouter ?? base.ModelRouter,
    ConstitutionLoader: overrides.ConstitutionLoader ?? base.ConstitutionLoader,
    ModelRegistry: overrides.ModelRegistry ?? base.ModelRegistry,
    isCommandAvailable: overrides.isCommandAvailable ?? base.isCommandAvailable,
    defaultFindPortListeners: overrides.defaultFindPortListeners ?? base.defaultFindPortListeners,
    reapOrphanProcesses: overrides.reapOrphanProcesses ?? base.reapOrphanProcesses,
    estimateTrailingSpend: overrides.estimateTrailingSpend ?? base.estimateTrailingSpend,
    formatUsageReport: overrides.formatUsageReport ?? base.formatUsageReport,
    watchUsage: overrides.watchUsage ?? base.watchUsage,
    fetchSubscriptionUsage: overrides.fetchSubscriptionUsage ?? base.fetchSubscriptionUsage,
    diagnoseModels: overrides.diagnoseModels ?? base.diagnoseModels,
    probeDeclaredHarnesses: overrides.probeDeclaredHarnesses ?? base.probeDeclaredHarnesses,
    writeLocalRunReport: overrides.writeLocalRunReport ?? base.writeLocalRunReport,
  };
}

type PhaseKey = 'planPhase' | 'buildPhase' | 'checkPhase' | 'shipPhase';
type PhaseOps = Required<Pick<CliDeps, PhaseKey>>;

const DEFAULT_PHASE_OPS: PhaseOps = { planPhase, buildPhase, checkPhase, shipPhase };

/** factory-core phases for the current main() invocation; DEFAULT_PHASE_OPS outside it. */
let phaseOps: PhaseOps = DEFAULT_PHASE_OPS;

/** Per-field `??` so an explicit `undefined` override falls back instead of replacing the default. */
function resolvePhaseOps(overrides: Partial<PhaseOps>, base: PhaseOps = phaseOps): PhaseOps {
  return {
    planPhase: overrides.planPhase ?? base.planPhase,
    buildPhase: overrides.buildPhase ?? base.buildPhase,
    checkPhase: overrides.checkPhase ?? base.checkPhase,
    shipPhase: overrides.shipPhase ?? base.shipPhase,
  };
}

export const PREREQUISITES_TEXT = `First step: run \`factory doctor\` to check your setup and see what to fix.

Prerequisites:
  - Claude Code CLI installed and authenticated (Claude subscription): https://claude.com/claude-code
  - GitHub CLI authenticated: gh auth login
  - GITHUB_TOKEN or GH_TOKEN set (falls back to \`gh auth token\`)
Run inside a git repository with a GitHub remote.
`;

/** Printed after the command list in `factory --help`: the env vars operators reach for most. */
export const HELP_FOOTER_TEXT = `
Common environment variables:
  FACTORY_MERGE=1                     Squash-merge eligible PRs (--auto-merge / --no-auto-merge win)
  FACTORY_MERGE_ADMIN=1               Merge with GitHub admin bypass of unmet requirements
  FACTORY_SKIP_CI=1                   Do not wait for CI before merging
  FACTORY_SANDBOX=0                   Disable the containment sandbox for agent runs (dangerous)
  FACTORY_PLAN_MODEL=<id>             Pick the PLAN model
  FACTORY_BUILD_MODEL=<id>            Pick the BUILD model
  FACTORY_STOP_AT=<fraction>          Usage fraction (0-1] at which work pauses
  FACTORY_RESUME_AT=<fraction>        Usage fraction (0-1] at which paused work resumes
  FACTORY_ALLOW_STALE=1               Run even when the built CLI is older than its source
Every config key, its default, and its env var: docs/config.example.yaml

Run \`factory <command> --help\` for a command's options.
Docs: ${DOCS_URL}`;

// ---------- helpers ----------

/** PATH probe via the injectable shell seam (mirrors core isCommandAvailable). */
function isCommandAvailableViaShell(shell: ShellOps, cmd: string): boolean {
  try {
    shell.execSync(`command -v ${cmd} 2>/dev/null`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

async function getRepoRoot(shell: ShellOps = shellOps): Promise<string> {
  try {
    const { stdout } = await shell.exec('git rev-parse --show-toplevel');
    return stdout.trim();
  } catch {
    throw new CliExitError('factory: not inside a git repository', 2);
  }
}

const GH_UNAUTHENTICATED = /gh auth login|not logged in/i;
const GH_TOKEN_REJECTED = /bad credentials|HTTP 401|401 Unauthorized/i;
const GH_NO_GITHUB_REMOTE = /no git remotes found|point to a known GitHub host/i;

/**
 * CliExitError message for a failed `gh repo view`; names a rejected token and its `repo` scope when gh reports a 401 (#2593),
 * and gh auth when gh's stderr says it is logged out (#2592). The 401 check runs first because gh's 401 output also says "gh auth login".
 * gh's known-host remote error is checked before the auth pattern because it also names `gh auth login` (#2594).
 */
export function ghRepoViewFailureMessage(stderr: string | undefined): string {
  const detail = stderr
    ?.trim()
    .split('\n')
    .find((l) => l.trim())
    ?.trim();
  if (stderr && GH_TOKEN_REJECTED.test(stderr)) {
    return `factory: GitHub rejected the token (GH_TOKEN/GITHUB_TOKEN); use a token with the \`repo\` scope${detail ? ` (gh repo view failed: ${detail})` : ''}`;
  }
  if (stderr && GH_NO_GITHUB_REMOTE.test(stderr)) {
    return 'factory: no GitHub remote detected (gh repo view failed)';
  }
  if (stderr && GH_UNAUTHENTICATED.test(stderr)) {
    return `factory: gh is not authenticated, run \`gh auth login\`${detail ? ` (gh repo view failed: ${detail})` : ''}`;
  }
  return 'factory: no GitHub remote detected (gh repo view failed)';
}

async function getGitHubRepo(shell: ShellOps = shellOps): Promise<string> {
  try {
    const { stdout } = await shell.exec('gh repo view --json nameWithOwner --jq .nameWithOwner');
    return stdout.trim();
  } catch (err) {
    const stderr = (err as { stderr?: unknown } | null)?.stderr;
    throw new CliExitError(ghRepoViewFailureMessage(typeof stderr === 'string' ? stderr : undefined), 2);
  }
}

/** Env token first, then one `gh auth token` subprocess (≤5 s). `undefined` when neither yields one. */
function resolveGitHubToken(shell: ShellOps = shellOps): string | undefined {
  let token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!token) {
    try {
      const out = shell.execSync('gh auth token', { timeout: 5_000 });
      token = out.trim() || undefined;
    } catch {}
  }
  return token;
}

/** Octokit factory for the current main() or cmdLand invocation (CliDeps.octokit); unset outside them. */
let octokitFactory: (() => Octokit) | undefined;

function getOctokit(shell: ShellOps = shellOps, options?: FactoryOctokitOptions): Octokit {
  return octokitFactory
    ? octokitFactory()
    : selectOctokit(process.env, () => createFactoryOctokit(resolveGitHubToken(shell), options));
}

export function errorDetail(err: unknown): string {
  const e = err as { stderr?: unknown; message?: unknown } | null;
  const stderr = typeof e?.stderr === 'string' ? e.stderr.trim() : '';
  if (stderr) return stderr;
  if (typeof e?.message === 'string' && e.message) return e.message;
  return String(err);
}

// The land flow (land.ts, land-pr.ts) reads these live, so per-call deps injection reaches it (#2784).
setLandRuntime(() => ({
  configLoaders,
  gitOps,
  internalOps,
  shellOps,
  getOctokit: () => getOctokit(),
  errorDetail,
  worktreePathFor,
  LaneParkError,
}));

// The ship flow (ship.ts, ship-steps.ts) reads these live, so per-call deps injection reaches it (#2788).
setShipRuntime(() => ({
  resolveConfigLoaders: (overrides) => resolveConfigLoaders(overrides),
  resolveGitOps: (overrides) => resolveGitOps(overrides),
  resolveShellOps: (overrides) => resolveShellOps(overrides),
  resolveCoreOps: (overrides) => resolveCoreOps(overrides),
  resolvePhaseOps: (overrides) => resolvePhaseOps(overrides),
  getRepoRoot,
  getGitHubRepo,
  getOctokit,
  worktreePathFor,
  repoConfigFileFor,
  isCommandAvailableViaShell,
  readTextFileOrEmpty,
  readActiveProduct,
  errorDetail,
  resolveEnvironmentAcquirer,
  resolveLaneBaseUrl,
  defaultWriteLocalRunReport: () => coreOps.writeLocalRunReport,
  LaneParkError,
  LaneEnvironmentPauseError,
  IssueSkippedError,
  IssueDecomposedError,
}));

export { shipIssue };

export function hasGitHubToken(env: NodeJS.ProcessEnv = process.env, tryToken?: () => string): boolean {
  if (env.GITHUB_TOKEN || env.GH_TOKEN) return true;
  try {
    const out = (tryToken ?? (() => shellOps.execSync('gh auth token', { timeout: 5_000 })))();
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

// ---------- commands ----------

/** The minimal, pin-free repo config `factory init` writes. No model pins → routing
 *  stays on packaged defaults (policy=auto). YAML (header comment + `version: 2`) by default;
 *  `'json'` gives two-space JSON + trailing newline for repos that already use config.json.
 *  Every available key is documented in docs/config.example.jsonc. */
export function buildInitConfig(format: 'yaml' | 'json' = 'yaml'): string {
  if (format === 'json') return JSON.stringify({ version: 2 }, null, 2) + '\n';
  return REPO_CONFIG_YAML_HEADER + 'version: 2\n';
}

/** Write content once without a check-then-act race. Callers choose whether an
 * existing file is preserved or overwritten. */
function writeIfAbsent(path: string, content: string, label: string, force = false): void {
  if (force) {
    writeFileSync(path, content);
    console.log(styleText('green', `Wrote ${path}`));
    return;
  }
  try {
    writeFileSync(path, content, { flag: 'wx' });
    console.log(styleText('green', `Wrote ${path}`));
  } catch (err: any) {
    if (err.code === 'EEXIST') {
      console.log(styleText('yellow', `${label} exists — leaving as-is (use --force to overwrite)`));
      return;
    }
    throw err;
  }
}

/** One-line onboarding reachability summary, e.g. "policy=auto, 3/7 models reachable". */
export function formatInitReachability(diagnoses: ModelDiagnosis[]): string {
  return `policy=auto, ${formatReachabilityCount(diagnoses)}`;
}

/** Shared "K/N models reachable[, U unverified (no auth evidence)]" count for init and models --doctor. */
export function formatReachabilityCount(diagnoses: ModelDiagnosis[]): string {
  const reachable = diagnoses.filter((d) => d.reachable).length;
  const unverified = diagnoses.filter((d) => !d.reachable && d.unverified).length;
  const base = `${reachable}/${diagnoses.length} models reachable`;
  return unverified > 0 ? `${base}, ${unverified} unverified (no auth evidence)` : base;
}

async function cmdInit(opts: { force?: boolean } = {}) {
  const repoRoot = await getRepoRoot();
  // init itself never calls GitHub, so a missing token is a warning here; ship/run still need one.
  if (!hasGitHubToken()) {
    console.error(styleText('yellow', `factory: warning: ${missingTokenMessage()}`));
  }
  const paths = getFactoryPaths(repoRoot);
  ensureDir(paths.root);
  ensureDir(paths.logs);
  ensureDir(paths.plans);

  // Add .factory/ to git exclude
  ensureFactoryExcluded(resolve(repoRoot, '.git/info/exclude'));

  // Create sample queue if not exists
  writeSampleQueue(paths.queue);

  // Write onboarding files. Idempotent: never clobber an existing file unless --force.
  const force = opts.force === true;
  // A fresh repo gets config.yaml; an existing config keeps its own format (--force never switches it).
  const configPath = existsSync(paths.config) ? paths.config : resolve(paths.root, 'config.yaml');
  const constitutionPath = resolve(paths.root, 'constitution.md');
  const gitignorePath = resolve(paths.root, '.gitignore');

  writeIfAbsent(
    configPath,
    buildInitConfig(configPath.endsWith('.json') ? 'json' : 'yaml'),
    `.factory/${basename(configPath)}`,
    force,
  );

  // Constitution scaffold: the active product's bundled file, else the default-code constitution.
  const constitutionsDir = configLoaders.getConstitutionsDir();
  const active = readActiveProduct(paths.product);
  const activeFile = active ? resolve(constitutionsDir, `${active}.md`) : undefined;
  const source = activeFile && existsSync(activeFile) ? activeFile : resolve(constitutionsDir, 'default-code.md');
  writeIfAbsent(constitutionPath, readFileSync(source, 'utf-8'), '.factory/constitution.md', force);

  writeIfAbsent(gitignorePath, 'state/\n', '.factory/.gitignore', force);

  // Doctor-style validation (policy=auto, N models reachable) — informational, never fails init.
  const modelsConfig = applyRepoConfig(configLoaders.loadModelsConfig(), configLoaders.loadRepoConfig(repoRoot));
  const registry = new coreOps.ModelRegistry(modelsConfig);
  const diagnoses = coreOps.diagnoseModels(
    registry,
    modelDoctorProbes({ requireOllamaOnPath: true }),
    resolveExperimental(),
    resolveLocalOnly(),
  );
  console.log(formatInitReachability(diagnoses));
  if (!hasReachableWorker(diagnoses)) {
    console.log(
      styleText('yellow', 'No worker model reachable yet — see `factory doctor` and `factory models --doctor`.'),
    );
  }

  console.log(styleText('green', `Initialized ${paths.root}`));
  console.log(
    'Next: factory doctor, then factory triage (optional: factory constitution --product <name> to swap the default constitution)',
  );
}

/** Rewrite a checkout's legacy `.factory/` inputs and runtime files to the v2
 * layout. Every write is idempotent so it is safe to run this more than once. */
export async function runMigrate(
  repoRoot: string,
  opts: { dryRun?: boolean; toYaml?: boolean; migrateToYaml?: typeof migrateRepoConfigToYaml } = {},
): Promise<void> {
  const dryRun = opts.dryRun === true;
  const paths = getFactoryPaths(repoRoot);

  if (opts.toYaml) {
    let result: RepoConfigYamlMigration;
    try {
      result = (opts.migrateToYaml ?? migrateRepoConfigToYaml)(paths.root, { dryRun });
    } catch (err) {
      throw new CliExitError(`factory: ${(err as Error).message}`, 1);
    }
    switch (result.status) {
      case 'migrated':
        console.log('converted .factory/config.json to .factory/config.yaml');
        return;
      case 'would-migrate':
        console.log('would convert .factory/config.json to .factory/config.yaml');
        return;
      case 'already-yaml':
        console.log(`config already YAML (${basename(result.path)}) — nothing to convert`);
        return;
      case 'no-config':
        console.log('no .factory/config.json — nothing to convert');
        return;
      case 'round-trip-failed':
        throw new CliExitError(
          `factory: config.yaml did not round-trip (${result.reason}); kept .factory/config.json`,
          1,
        );
    }
  }
  const isRuntimePath = (path: string) => {
    const fromState = relative(paths.state, path);
    return fromState !== '' && !fromState.startsWith('..') && !resolve(paths.state, fromState).startsWith('..');
  };

  if (!dryRun) mkdirSync(paths.state, { recursive: true });
  const transientLocks = new Set(['merge.lock', 'git.lock', 'run.lock']);
  for (const path of Object.values(paths)) {
    if (!isRuntimePath(path) || transientLocks.has(basename(path))) continue;
    const legacyPath = resolve(paths.root, basename(path));
    if (!existsSync(legacyPath) || existsSync(path)) continue;
    if (dryRun) {
      console.log(`would move ${legacyPath} to ${path}`);
    } else {
      renameSync(legacyPath, path);
      console.log(`moved ${legacyPath} to ${path}`);
    }
  }

  let rawConfig: Record<string, unknown> | undefined;
  try {
    rawConfig = JSON.parse(readFileSync(paths.config, 'utf-8'));
  } catch (err: any) {
    if (err.code !== 'ENOENT') throw err;
  }
  if (!rawConfig) {
    console.log('no .factory/config.json — nothing to rewrite');
  } else if (rawConfig.version === 2) {
    console.log('config.json already v2');
  } else {
    const v2 = configLoaders.loadRepoConfig(repoRoot);
    if (!v2) throw new Error(`Expected ${paths.config} to exist`);
    const { $schema: _schema, version: _version, ...rest } = v2;
    // loadRepoConfig only returns the model-routing namespace; carry the runtime-policy
    // keys (sweep, run, timeouts, ...) over verbatim so the rewrite does not drop them.
    const source = rawConfig;
    const runtime = Object.fromEntries(
      FACTORY_RUNTIME_CONFIG_KEYS.filter((key) => key in source).map((key) => [key, source[key]]),
    );
    const content =
      JSON.stringify(
        {
          ...(typeof rawConfig.$schema === 'string' ? { $schema: rawConfig.$schema } : {}),
          version: 2,
          ...rest,
          ...runtime,
        },
        null,
        2,
      ) + '\n';
    if (dryRun) {
      console.log('would rewrite .factory/config.json to v2');
    } else {
      writeFileSync(paths.config, content);
      console.log('rewrote .factory/config.json to v2');
    }
  }

  const constitutionPath = resolve(paths.root, 'constitution.md');
  if (!existsSync(constitutionPath)) {
    const product = readActiveProduct(paths.product);
    const productConstitution = product ? resolve(configLoaders.getConstitutionsDir(), `${product}.md`) : undefined;
    const content =
      productConstitution && existsSync(productConstitution)
        ? readFileSync(productConstitution, 'utf-8')
        : scaffoldConstitution(
            readFileSync(resolve(configLoaders.getConstitutionsDir(), '_template.md'), 'utf-8'),
            basename(repoRoot),
          );
    if (dryRun) {
      console.log('would write .factory/constitution.md');
    } else {
      writeIfAbsent(constitutionPath, content, '.factory/constitution.md');
    }
  } else {
    console.log('constitution.md already exists');
  }

  const gitignorePath = resolve(paths.root, '.gitignore');
  if (!existsSync(gitignorePath)) {
    if (dryRun) {
      console.log('would write .factory/.gitignore');
    } else {
      writeIfAbsent(gitignorePath, 'state/\n', '.factory/.gitignore');
    }
  } else {
    console.log('.gitignore already exists');
  }

  console.log(dryRun ? 'Migration preview complete.' : 'Migrated .factory/ to the v2 layout.');
  console.log('Verify: factory status');
}

async function cmdMigrate(opts: { dryRun?: boolean; toYaml?: boolean } = {}): Promise<void> {
  await runMigrate(await getRepoRoot(), opts);
}

export class InvalidProductNameError extends Error {}

/** Expected user-facing CLI failure. Thrown by command helpers; only main() maps it to a process exit code. */
export class CliExitError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
    this.name = 'CliExitError';
  }
}

/** Parse a CLI <issue> argument. Throws CliExitError(2) before any git/GitHub work runs. */
export function parseIssueArg(raw: string): number {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed) || Number(trimmed) < 1) {
    throw new CliExitError(`factory: invalid issue argument '${raw}' — expected a positive integer issue number`, 2);
  }
  return Number(trimmed);
}

/** Run `factory feedback` and print the filed issue; validation errors become exit-2 CliExitErrors. */
export async function runFeedbackCommand(
  prUrl: string,
  opts: { note?: string },
  deps: FeedbackDeps,
  log: (line: string) => void = console.log,
): Promise<void> {
  try {
    const result = await runFeedback(prUrl, opts, deps);
    log(`Filed ${result.repo}#${result.issueNumber}`);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('factory feedback:')) throw new CliExitError(err.message, 2);
    throw err;
  }
}

/** owner/name of the checkout's origin remote, or null when there is none or it is not a GitHub remote. Never throws. */
export async function readOriginSlug(shell: ShellOps = shellOps): Promise<string | null> {
  try {
    const { stdout } = await shell.exec('git remote get-url origin');
    return parseRemoteSlug(stdout.trim());
  } catch {
    return null;
  }
}

export async function cmdFeedback(
  prUrl: string,
  opts: { note?: string; branchPrefix?: string; repo?: string; includeLocalPaths?: boolean },
): Promise<void> {
  const paths = getFactoryPaths(await getRepoRoot());
  const prefix = opts.branchPrefix === undefined ? resolveBranchPrefix() : branchPrefixOrExit(opts.branchPrefix);
  let repo: string | undefined;
  try {
    repo = resolveFeedbackRepo({
      flag: opts.repo,
      config: configLoaders.loadFactoryConfigForRepo(paths.config).filing.repo,
      remote: await readOriginSlug(),
    });
  } catch (err) {
    throw new CliExitError(err instanceof Error ? err.message : String(err), 2);
  }
  await runFeedbackCommand(
    prUrl,
    opts,
    buildFeedbackDeps(getOctokit(), paths, prefix, createOctokitFilingClient, {
      repo,
      shareLocal: opts.includeLocalPaths === true,
    }),
  );
}

async function resolveFactoryCommit(): Promise<string | null> {
  return resolveFactoryCheckoutCommit(
    dirname(fileURLToPath(import.meta.url)),
    async (cmd, cwd) => (await shellOps.exec(cmd, { cwd })).stdout,
  );
}

export async function cmdFilingPreview(runId: string, opts: { branchPrefix?: string }): Promise<void> {
  const paths = getFactoryPaths(await getRepoRoot());
  const prefix = opts.branchPrefix === undefined ? resolveBranchPrefix() : branchPrefixOrExit(opts.branchPrefix);
  const found = await runFilingPreview(runId, {
    out: process.stdout,
    err: process.stderr,
    eventsFile: paths.events,
    runsDir: daemonRuntimePaths().runsDir,
    factoryVersion: getCliVersion(),
    factoryCommit: resolveFactoryCommit,
    os: `${platform()} ${release()} ${arch()}`,
    nodeVersion: process.version,
    usernames: [userInfo().username],
    hostnames: [osHostname()],
    branchPrefix: prefix,
  });
  if (!found) throw new CliExitError(`no failure evidence found for run ${runId}`, 2);
}

function branchPrefixOrExit(raw: string | undefined): string {
  const prefix = resolveBranchPrefixOption(raw);
  if (prefix === null) throw new CliExitError(INVALID_BRANCH_PREFIX_MESSAGE, 2);
  return prefix;
}

function sizeGateOrExit(raw: string | undefined): SizeGateMode | undefined {
  if (raw === undefined) return undefined;
  const mode = parseSizeGateMode(raw);
  if (mode === undefined) {
    throw new CliExitError(`factory: invalid --size-gate '${raw}' — expected one of: ${SIZE_GATE_MODES.join(', ')}`, 2);
  }
  return mode;
}

function maxSlicesOrExit(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = parseMaxSlices(raw);
  if (n === undefined) {
    throw new CliExitError(`factory: invalid --max-slices '${raw}' — expected a whole number from 1 to 20`, 2);
  }
  return n;
}

/** Deterministic run number for a brief, derived from its content digest.
 *  Reserved 9,000,000+ range keeps brief branches/worktrees clear of real issue numbers. */
function briefRunNumber(sha256Hex: string): number {
  return 9_000_000 + (Number.parseInt(sha256Hex.slice(0, 8), 16) % 1_000_000);
}

// Product names become a filename in the constitutions dir; keep them to a safe,
// listable charset. Leading '_' is reserved (listProducts hides `_*.md`).
export function assertValidProduct(product: string): void {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(product)) {
    throw new InvalidProductNameError(
      `invalid product name '${product}': use letters, digits, '.', '_' or '-' and do not start with '_' or '.'`,
    );
  }
}

export interface ReadActiveProductDeps {
  fileExists?: (p: string) => boolean;
  readFile?: (p: string) => string;
}

/**
 * Read the active product name from the `.factory/product` file.
 * Returns the trimmed content, or undefined when the file is missing
 * or contains only whitespace.
 */
export function readActiveProduct(productPath: string, deps: ReadActiveProductDeps = {}): string | undefined {
  const { fileExists = existsSync, readFile = (p: string) => readFileSync(p, 'utf-8') } = deps;
  if (!fileExists(productPath)) return undefined;
  const product = readFile(productPath).trim();
  return product || undefined;
}

/** Extract the template's ```markdown skeleton and fill in the product name. */
export function scaffoldConstitution(template: string, product: string): string {
  const match = template.match(/```markdown\n([\s\S]*?)```/);
  if (!match) {
    throw new Error('constitution template is missing its ```markdown skeleton block');
  }
  const skeleton = match[1].replace(/\s+$/, '') + '\n';
  const display = product
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
  return skeleton.replaceAll('<product-name>', JSON.stringify(product)).replaceAll('<Product>', display);
}

/**
 * True when `existing` is an untouched scaffold: byte-identical (CRLF and trailing whitespace
 * normalised) to a bundled constitution or to the legacy `_template.md` scaffold for `repoName`.
 * Exact equality only — an edited file is never treated as a scaffold.
 */
export function isUnmodifiedConstitutionScaffold(
  existing: string,
  constitutionsDir: string,
  repoName: string,
): boolean {
  const norm = (s: string) => s.replace(/\r\n/g, '\n').trimEnd();
  const target = norm(existing);
  if (target === '') return true;
  let names: string[] = [];
  try {
    names = readdirSync(constitutionsDir).filter((f) => f.endsWith('.md') && !f.startsWith('_'));
  } catch {
    // unreadable dir: no bundled files to compare against
  }
  for (const f of names) {
    try {
      if (norm(readFileSync(resolve(constitutionsDir, f), 'utf-8')) === target) return true;
    } catch {
      // skip unreadable entries
    }
  }
  try {
    const template = readFileSync(resolve(constitutionsDir, '_template.md'), 'utf-8');
    return norm(scaffoldConstitution(template, repoName)) === target;
  } catch {
    return false;
  }
}

export async function cmdConstitution(
  opts: {
    list?: boolean;
    checkers?: boolean;
    product?: string;
    init?: string | boolean;
    force?: boolean;
  },
  deps: Pick<CliDeps, 'ConstitutionLoader'> = {},
) {
  const loader = new (resolveCoreOps(deps).ConstitutionLoader)();

  if (typeof opts.init === 'string' || opts.init === true) {
    const product = typeof opts.init === 'string' ? opts.init : undefined;
    if (product !== undefined) {
      try {
        assertValidProduct(product);
      } catch (err) {
        if (err instanceof InvalidProductNameError) {
          throw new CliExitError(err.message, 2);
        }
        throw err;
      }
    }
    const repoRoot = await getRepoRoot();
    const paths = getFactoryPaths(repoRoot);
    ensureDir(paths.root);
    const constitutionPath = resolve(paths.root, 'constitution.md');
    if (existsSync(constitutionPath) && !opts.force) {
      throw new CliExitError('.factory/constitution.md already exists — use --force to overwrite', 1);
    }
    const template = readFileSync(resolve(configLoaders.getConstitutionsDir(), '_template.md'), 'utf-8');
    const content = scaffoldConstitution(template, product ?? basename(repoRoot));
    writeIfAbsent(constitutionPath, content, '.factory/constitution.md', opts.force);
    console.log(`Next: factory constitution --product ${product ?? basename(repoRoot)}`);
    return;
  }

  if (opts.list) {
    const products = loader.listProducts();
    for (const p of products) {
      try {
        const checkers = loader.load(p).checkers.join(', ');
        console.log(`  ${p} — ${checkers || '(no checkers)'}`);
      } catch {
        console.log(`  ${p}`);
      }
    }
    return;
  }

  if (opts.checkers) {
    for (const c of listBuiltInCheckers()) console.log(`  ${c.name} — ${c.description}`);
    console.log(
      "  custom_<name> — agent-judged checker graded against the constitution body (declare it in the constitution's checkers list)",
    );
    return;
  }

  if (opts.product) {
    const products = loader.listProducts();
    if (!products.includes(opts.product)) {
      throw new CliExitError(`No constitution '${opts.product}' found. Available products: ${products.join(', ')}`, 1);
    }
    const repoRoot = await getRepoRoot();
    const paths = getFactoryPaths(repoRoot);
    ensureDir(paths.root);
    const constitutionPath = resolve(paths.root, 'constitution.md');
    const constitutionsDir = configLoaders.getConstitutionsDir();
    const scaffold =
      existsSync(constitutionPath) &&
      isUnmodifiedConstitutionScaffold(readFileSync(constitutionPath, 'utf-8'), constitutionsDir, basename(repoRoot));
    if (existsSync(constitutionPath) && !opts.force && !scaffold) {
      throw new CliExitError('.factory/constitution.md already exists — use --force to overwrite', 1);
    }
    const content = readFileSync(resolve(constitutionsDir, `${opts.product}.md`), 'utf-8');
    writeIfAbsent(constitutionPath, content, '.factory/constitution.md', opts.force || scaffold);

    ensureDir(paths.state);
    writeFileSync(paths.product, opts.product);
    console.log(styleText('green', `Active product: ${opts.product}`));
    return;
  }

  throw new CliExitError('usage: factory constitution --init <product> | --list | --checkers | --product <name>', 2);
}

/** Single owner of the per-model status icon, shared by `factory models` and `models --doctor` (#2402). */
export function modelStatusIcon(d: ModelDiagnosis): string {
  return d.reachable ? styleText('green', '✅') : d.unverified ? styleText('yellow', '⚠️') : styleText('red', '❌');
}

/** Single owner of the `[repo-defined]` marker for models declared in `.factory/config.json` models.registry, shared by `factory models` and `models --doctor` (#2443). */
export function repoDefinedTag(model: string, repoDefined: ReadonlySet<string>): string {
  return repoDefined.has(model) ? styleText('cyan', ' [repo-defined]') : '';
}

export function formatDoctorReport(diagnoses: ModelDiagnosis[], repoDefined: ReadonlySet<string> = new Set()): string {
  const lines = [styleText('bold', '\n== Model Doctor ==')];
  for (const d of diagnoses) {
    const icon = modelStatusIcon(d);
    const tiers = d.tiers.join('/');
    lines.push(
      `  ${icon} ${d.model} provider=${d.provider} tier=${tiers} — ${d.reason}${repoDefinedTag(d.model, repoDefined)}`,
    );
  }
  lines.push(`  ${formatReachabilityCount(diagnoses)}`);
  return lines.join('\n');
}

export function hasReachableWorker(diagnoses: ModelDiagnosis[]): boolean {
  return diagnoses.some((d) => d.reachable && (d.tiers.includes('worker') || d.tiers.includes('worker_fallback')));
}

function ollamaModelSet(requireOnPath = false): Set<string> | undefined {
  if (requireOnPath && !coreOps.isCommandAvailable('ollama')) return undefined;
  try {
    const out = shellOps.execSync('ollama list', { timeout: 10_000 });
    return new Set(
      out
        .split('\n')
        .slice(1)
        .map((line) => line.trim().split(/\s+/)[0])
        .filter(Boolean),
    );
  } catch {
    return undefined;
  }
}

/** Probes shared by every doctor-style reachability check (init, models --doctor, overnight
 *  preflight), so their counts agree. init passes `requireOllamaOnPath` so a missing binary never
 *  reaches the shell (#2507). */
export function modelDoctorProbes(opts: { requireOllamaOnPath?: boolean } = {}): DoctorProbes {
  const ollamaModels = ollamaModelSet(opts.requireOllamaOnPath === true);
  return {
    commandAvailable: coreOps.isCommandAvailable,
    ollamaModelPresent: ollamaModels ? (model: string) => ollamaModels.has(model) : undefined,
  };
}

async function cmdModels(opts: { doctor?: boolean } = {}) {
  const repoRoot = await getRepoRoot();
  const repoConfig = configLoaders.loadRepoConfig(repoRoot);
  const modelsConfig = applyRepoConfig(configLoaders.loadModelsConfig(), repoConfig);
  const repoDefined = new Set(Object.keys(repoConfig?.models?.registry ?? {}));
  const registry = new coreOps.ModelRegistry(modelsConfig);
  const allowExperimental = resolveExperimental();
  const localOnly = resolveLocalOnly();

  const diagnoses = coreOps.diagnoseModels(registry, modelDoctorProbes(), allowExperimental, localOnly);

  if (opts.doctor) {
    console.log(formatDoctorReport(diagnoses, repoDefined));
    if (!hasReachableWorker(diagnoses)) {
      throw new CliExitError('factory: no worker model is reachable — fix the reasons above before running a queue', 1);
    }
    return;
  }

  console.log(styleText('bold', '\n== Available Models =='));
  const byModel = new Map(diagnoses.map((d) => [d.model, d]));
  for (const m of registry.list()) {
    const tiers = registry.getTiers(m).join('/');
    const est = registry.estimateCost(m, 1_000_000, 1_000_000);
    const cost = est === null ? 'unpriced' : `$${est.toFixed(2)}/M`;
    const d = byModel.get(m);
    const avail = d ? modelStatusIcon(d) : styleText('red', '❌');
    const tag = registry.isExperimental(m) ? styleText('yellow', ' [experimental]') : '';
    console.log(`  ${avail} ${m} tier=${tiers} ${cost}${tag}${repoDefinedTag(m, repoDefined)}`);
  }

  console.log(styleText('bold', '\n== Tiers =='));
  for (const tier of ['boss', 'worker', 'checker', 'triage']) {
    const models = registry.getModelsInTier(tier);
    console.log(`  ${tier}: ${models.join(' ')}`);
  }
}

async function cmdCost(opts: { issue?: string; json?: boolean } = {}) {
  const repoRoot = await getRepoRoot();
  const paths = getFactoryPaths(repoRoot);
  if (opts.json) {
    let jsonCosts: ReturnType<typeof internalOps.readCosts>;
    try {
      jsonCosts = internalOps.readCosts(paths.costs);
    } catch (err) {
      throw new CliExitError(`factory: cost failed — ${errorDetail(err)}`, 1);
    }
    console.log(JSON.stringify(buildCostJson(jsonCosts, opts.issue)));
    return;
  }
  const costs = internalOps.readCosts(paths.costs);

  if (opts.issue) {
    const filtered = costs.filter((c) => c.issue === String(opts.issue));
    if (filtered.length === 0) {
      console.log(`no cost data for issue ${opts.issue}`);
      return;
    }
    console.log(styleText('bold', `== Costs for issue ${opts.issue} ==`));
    for (const c of filtered) {
      console.log(
        `  ${c.task} ${c.model} ${c.cost === null || c.cost === undefined ? 'unknown' : `$${c.cost.toFixed(4)}`}${c.failoverReason ? ` [failover: ${c.failoverReason}]` : ''}`,
      );
    }
    const t = aggregateCosts(filtered).total;
    console.log('  ---');
    console.log(`  Total: ${formatCostTotal(t.cost, t.unpricedCount)}`);
    return;
  }

  if (costs.length === 0) {
    console.log('no cost data yet');
    return;
  }

  const byModel = new Map<
    string,
    { tasks: number; priced: number; pricedCount: number; unpriced: number; failovers: number }
  >();
  for (const c of costs) {
    const e = byModel.get(c.model) ?? { tasks: 0, priced: 0, pricedCount: 0, unpriced: 0, failovers: 0 };
    e.tasks++;
    if (c.unpriced === true || c.cost === null || c.cost === undefined) e.unpriced++;
    else {
      e.priced += c.cost;
      e.pricedCount++;
    }
    if (c.failoverReason) e.failovers++;
    byModel.set(c.model, e);
  }

  console.log(styleText('bold', '== Cost Summary =='));
  for (const [model, { tasks, priced, pricedCount, unpriced, failovers }] of byModel) {
    const failoverSuffix = failovers > 0 ? ` (${failovers} failover${failovers === 1 ? '' : 's'})` : '';
    const modelCost = formatCostTotal(pricedCount === 0 && unpriced > 0 ? null : priced, unpriced);
    console.log(`  ${model}: ${tasks} tasks, ${modelCost}${failoverSuffix}`);
  }
  const grand = aggregateCosts(costs).total;
  console.log('  ---');
  console.log(`  Total: ${formatCostTotal(grand.cost, grand.unpricedCount)}`);
}

async function cmdCheck(issueRaw: string, opts: { json?: boolean; deep?: boolean }) {
  const issueNum = parseIssueArg(issueRaw);
  const ghRepo = await getGitHubRepo();
  const [owner, repoName] = ghRepo.split('/');
  let runModel: DeepCheckModelRunner | undefined;
  if (opts.deep) {
    const repoRoot = await getRepoRoot();
    const repoConfig = configLoaders.loadRepoConfig(repoRoot);
    const effective = resolveEffectiveConfig(repoConfig);
    const router = new coreOps.ModelRouter(
      applyRepoConfig(configLoaders.loadModelsConfig(), repoConfig),
      configLoaders.loadRoutesConfig(),
      false,
      undefined,
      effective.allowExperimental,
      effective.localOnly,
    );
    router.setLocalAuthSink?.(recordLocalAuthFailure);
    runModel = createDeepModelRunner(router, repoRoot);
  }
  let report;
  try {
    report = await runIssueCheck(issueNum, opts, {
      runModel,
      getIssue: async (n) => {
        const { data } = await getOctokit().rest.issues.get({ owner, repo: repoName, issue_number: n });
        return { title: data.title, body: data.body ?? null };
      },
      getIssueState: async (n) => {
        const { data } = await getOctokit().rest.issues.get({ owner, repo: repoName, issue_number: n });
        return data.state === 'closed' ? 'closed' : 'open';
      },
      log: (line) => console.log(line),
    });
  } catch (err) {
    if (err instanceof DeepCheckError) throw new CliExitError(`factory: --deep failed — ${err.message}`, 2);
    throw err;
  }
  if (report.exitCode === 1) {
    throw new CliExitError(`factory: issue #${issueNum} is not factory-ready — ${report.reasons.join('; ')}`, 1);
  }
  if (report.exitCode === 3) {
    throw new CliExitError(`factory: issue #${issueNum} would split — ${report.size.reason}`, 3);
  }
}

async function currentCommitSha(): Promise<string | null> {
  try {
    const { stdout } = await shellOps.exec('git rev-parse HEAD');
    return stdout.trim();
  } catch {
    return null;
  }
}

function resolvedModelTiers(repoRoot: string, stateRoot?: string): Record<string, string[]> {
  const modelsConfig = applyRepoConfig(
    configLoaders.loadModelsConfig(),
    configLoaders.loadRepoConfig(repoRoot, stateRoot),
  );
  return modelsConfig.tiers ?? {};
}

function readTextFileOrEmpty(path: string): string {
  try {
    return readFileSync(path, 'utf-8');
  } catch (err: any) {
    if (err.code === 'ENOENT') return '';
    throw err;
  }
}

/** Local events plus human-* events reconstructed from GitHub; warns and marks the result partial when the fetch fails (#2342). */
async function reconstructHumanEventsForKpis(
  events: FactoryEvent[],
  branchPrefix: string,
): Promise<KpiReconstruction & { owner: string; repoName: string }> {
  let owner = '';
  let repoName = '';
  const recon = await reconstructKpiEvents(events, async (issues) => {
    [owner, repoName] = (await getGitHubRepo()).split('/');
    return fetchHumanEventSources(getOctokit(), owner, repoName, issues, kpiBranchPrefixes(branchPrefix));
  });
  if (recon.partial) {
    console.error(
      styleText(
        'yellow',
        `factory: GitHub human-event reconstruction failed (${recon.error}) — KPI snapshot marked partial (local log only)`,
      ),
    );
  }
  return { ...recon, owner, repoName };
}

async function appendKpiSnapshot(
  paths: ReturnType<typeof getFactoryPaths>,
  repoRoot: string,
  kpis: HealthKpis,
  opts: { partial?: boolean } = {},
): Promise<{ record: KpiHistoryRecord; history: KpiHistoryRecord[] }> {
  const record = kpisToHistoryRecord(kpis, new Date().toISOString().slice(0, 10), {
    commitSha: await currentCommitSha(),
    models: resolvedModelTiers(repoRoot, paths.root),
    partial: opts.partial,
  });
  const updated = appendKpiHistoryLine(readTextFileOrEmpty(paths.kpiHistory), record);
  ensureDir(paths.state);
  writeFileSync(paths.kpiHistory, updated);
  return { record, history: parseKpiHistory(updated) };
}

function persistClassifierOutcomes(
  paths: ReturnType<typeof getFactoryPaths>,
  events: Parameters<typeof joinClassifierOutcomes>[0],
  sources: PrSource[],
  opts: { now: string; windowDays: number },
): void {
  const records = joinClassifierOutcomes(events, sources, opts);
  if (records.length === 0) return;
  const updated = mergeClassifierOutcomes(readTextFileOrEmpty(paths.classifierOutcomes), records);
  ensureDir(paths.state);
  writeFileSync(paths.classifierOutcomes, updated);
}

async function cmdClassifierReport(opts: { json?: boolean } = {}) {
  const repoRoot = await getRepoRoot();
  const paths = getFactoryPaths(repoRoot);
  const report = summarizeClassifierOutcomes(parseClassifierOutcomes(readTextFileOrEmpty(paths.classifierOutcomes)));
  if (opts.json) {
    console.log(JSON.stringify(report));
    return;
  }
  for (const line of formatClassifierReport(report)) console.log(line);
}

async function cmdClassifierBacktestEntry(opts: ClassifierBacktestOptions) {
  const branchPrefix = branchPrefixOrExit(opts.branchPrefix);
  const repoRoot = await getRepoRoot();
  const paths = getFactoryPaths(repoRoot);
  const [owner, repo] = (await getGitHubRepo()).split('/');
  const repoConfig = configLoaders.loadRepoConfig(repoRoot);
  const effective = resolveEffectiveConfig(repoConfig);
  const router = new coreOps.ModelRouter(
    applyRepoConfig(configLoaders.loadModelsConfig(), repoConfig),
    configLoaders.loadRoutesConfig(),
    false,
    undefined,
    effective.allowExperimental,
    effective.localOnly,
  );
  router.setLocalAuthSink?.(recordLocalAuthFailure);
  try {
    await cmdClassifierBacktest(
      { ...opts, branchPrefix },
      {
        repoRoot,
        paths,
        owner,
        repo,
        octokit: getOctokit(),
        router,
        rules: resolveReviewFloorRules(repoConfig),
        modelPin: repoConfig?.models?.pins?.classifier,
        windowDays: resolveDefectWindowDays(configLoaders.loadFactoryConfigForRepo(paths.config)),
        exec: (cmd) => shellOps.exec(cmd, { cwd: repoRoot }),
        readFile: (path) => readFileSync(path, 'utf-8'),
        appendFile: (path, text) => appendFileSync(path, text),
        ensureDir,
        readEvents: (path) => (existsSync(path) ? readEvents(path) : []),
        now: () => new Date().toISOString(),
        log: (line) => console.log(line),
      },
    );
  } catch (err) {
    if (err instanceof ClassifierBacktestInputError) throw new CliExitError(err.message, 2);
    throw err;
  }
}

/** Read-only GitHub search dedup (#2102); on any error every cluster is marked tracking unknown (#2103). */
async function annotateGardenClusters(clusters: GardenCluster[]): Promise<GardenCluster[]> {
  const warn = (err: unknown) =>
    console.error(`factory garden: issue search unavailable, tracking unknown: ${errorDetail(err)}`);
  try {
    const [owner, repo] = (await getGitHubRepo()).split('/');
    if (!owner || !repo) throw new Error('cannot resolve the GitHub repository');
    return await dedupGardenClusters(clusters, {
      client: createOctokitFilingClient(getOctokit()),
      owner,
      repo,
      onSearchError: warn,
    });
  } catch (err) {
    warn(err);
    return markGardenTrackingUnknown(clusters);
  }
}

async function cmdGarden(
  opts: {
    report?: boolean;
    since?: string;
    maxClusters?: string;
    json?: boolean;
    out?: string;
    onlyNew?: boolean;
  } = {},
) {
  if (!opts.report) {
    console.error('factory garden: pass --report (the only mode in this release)');
    process.exit(1);
  }
  const since = opts.since ?? DEFAULT_GARDEN_SINCE;
  const windowMs = parseGardenDuration(since);
  if (windowMs === undefined) {
    console.error(`factory garden: --since must look like 7d, 36h or 2w (got ${since})`);
    process.exit(1);
  }
  const maxRaw = opts.maxClusters ?? String(DEFAULT_GARDEN_MAX_CLUSTERS);
  if (!/^\d+$/.test(maxRaw) || Number(maxRaw) < 1) {
    console.error(`factory garden: --max-clusters must be a positive integer (got ${maxRaw})`);
    process.exit(1);
  }
  const maxClusters = Number(maxRaw);
  const repoRoot = await getRepoRoot();
  const paths = getFactoryPaths(repoRoot);
  const events = filterGardenWindow(readHarvestEvents([paths.events]), windowMs, new Date());
  const clusters = capGardenClusters(clusterGarden(events), maxClusters);
  const annotated = clusters.length === 0 ? clusters : await annotateGardenClusters(clusters);
  const shown = opts.onlyNew ? filterGardenOnlyNew(annotated) : annotated;
  const text = opts.json ? renderGardenJson(shown, { since, maxClusters }) : renderGardenReport(shown).join('\n');
  if (opts.out) {
    try {
      writeFileSync(opts.out, `${text}\n`);
    } catch (err) {
      console.error(`factory garden: cannot write ${opts.out}: ${(err as Error).message}`);
      process.exit(1);
    }
    console.error(`factory garden: wrote report to ${opts.out}`);
    return;
  }
  if (opts.json) console.log(text);
  else for (const line of text.split('\n')) console.log(line);
}

async function cmdKpis(opts: { branchPrefix?: string } = {}) {
  const branchPrefix = branchPrefixOrExit(opts.branchPrefix);
  const repoRoot = await getRepoRoot();
  const paths = getFactoryPaths(repoRoot);
  const events = existsSync(paths.events) ? readEvents(paths.events) : [];
  const costs = existsSync(paths.costs) ? internalOps.readCosts(paths.costs) : [];

  const recon = await reconstructHumanEventsForKpis(events, branchPrefix);
  let allEvents = recon.events;
  const prSources = recon.sources;
  const { owner, repoName } = recon;

  if (prSources.length > 0) {
    try {
      const windowDays = resolveDefectWindowDays(configLoaders.loadFactoryConfigForRepo(paths.config));
      const now = new Date().toISOString();
      const merged = mergedPrRefs(prSources);
      const sources = await fetchDefectSources(getOctokit(), owner, repoName, merged, { now, windowDays });
      allEvents = [...allEvents, ...detectPostMergeDefects(sources, allEvents, { now, windowDays })];
      try {
        persistClassifierOutcomes(paths, allEvents, prSources, { now, windowDays });
      } catch (err: any) {
        console.error(styleText('yellow', `factory: classifier outcomes not recorded (${err?.message ?? err})`));
      }
    } catch (err: any) {
      console.error(
        styleText(
          'yellow',
          `factory: post-merge defect signals unavailable (${err?.message ?? err}) — postMergeDefectRate omitted from this snapshot`,
        ),
      );
    }
  }

  const kpis = computeHealthKpis(allEvents, costs);

  let history: KpiHistoryRecord[];
  try {
    ({ history } = await appendKpiSnapshot(paths, repoRoot, kpis, { partial: recon.partial }));
  } catch (err: any) {
    console.error(
      styleText(
        'yellow',
        `factory: KPI snapshot failed (${err?.message ?? err}) — showing the report without persisting a new snapshot`,
      ),
    );
    const existing = readTextFileOrEmpty(paths.kpiHistory);
    history = existing ? parseKpiHistory(existing) : [];
  }

  console.log(renderKpiReport(kpis));
  console.log(renderKpiTrend(history));
}

export interface UsageKnobs {
  cap: number;
  stopAt: number;
  resumeAt: number;
  pollMs: number;
  watch: boolean;
  estimator: boolean;
  /** Where `watch` was decided — `'flag'` when `--usage-watch`/`--no-usage-watch` was supplied. */
  watchSource: WatchdogPolicySource;
  stopAtSource: WatchdogPolicySource;
  resumeAtSource: WatchdogPolicySource;
  pollSource: WatchdogPolicySource;
}

export function resolveUsageKnobs(
  env: NodeJS.ProcessEnv = process.env,
  repoConfig: RepoFactoryConfig | null = null,
  overrides: WatchdogPolicyOverrides = {},
): UsageKnobs {
  const { cap } = resolveUsageCap(repoConfig, env);
  const watchdog = resolveWatchdogPolicy(repoConfig, env, overrides);

  return {
    cap,
    stopAt: watchdog.stopAt,
    resumeAt: watchdog.resumeAt,
    pollMs: watchdog.pollMs,
    watch: watchdog.watch,
    estimator: watchdog.estimator,
    watchSource: watchdog.sources.watch,
    stopAtSource: watchdog.sources.stopAt,
    resumeAtSource: watchdog.sources.resumeAt,
    pollSource: watchdog.sources.pollMs,
  };
}

/** Human-readable name for whatever decided the usage-watch gate, used in the `factory run`
 *  and `factory supervise` logs so an explicit operator override is always attributable (#1404). */
export function usageWatchSourceLabel(source: WatchdogPolicySource, watch: boolean): string {
  switch (source) {
    case 'flag':
      return watch ? 'flag: --usage-watch' : 'flag: --no-usage-watch';
    case 'repo':
      return '.factory/config.json: budget.watchdog.watch';
    case 'env':
      return 'env: FACTORY_USAGE_WATCH';
    default:
      return 'default';
  }
}

export async function cmdUsage(
  deps: Pick<CliDeps, ShellOpKey | 'fetchSubscriptionUsage' | 'estimateTrailingSpend' | 'formatUsageReport'> = {},
  opts: { json?: boolean } = {},
) {
  const ops = resolveCoreOps(deps);
  const repoRoot = await getRepoRoot(resolveShellOps(deps));
  let knobs: UsageKnobs;
  try {
    knobs = resolveUsageKnobs(process.env, configLoaders.loadRepoConfig(repoRoot));
  } catch (err: any) {
    throw new CliExitError(`factory: ${err.message}`, 2);
  }

  if (opts.json) {
    const subscription = await ops.fetchSubscriptionUsage();
    let estimate: number | null;
    try {
      const spend = ops.estimateTrailingSpend();
      estimate = Number.isFinite(spend) ? spend : null;
    } catch {
      estimate = null;
    }
    console.log(JSON.stringify(buildUsageJson(subscription, estimate, knobs.cap)));
    return;
  }

  const subscriptionPromise = ops.fetchSubscriptionUsage();
  const spend = ops.estimateTrailingSpend();
  const heuristicLine = ops.formatUsageReport(spend, knobs.cap);

  const subscription = await subscriptionPromise;
  if (subscription !== null) {
    const resets = subscription.fiveHourResetsAt ? `, resets ${subscription.fiveHourResetsAt}` : '';
    console.log(`5h subscription usage: ${Math.round(subscription.fiveHourUtilization)}% of plan limit${resets}`);
    console.log(`heuristic list-price estimate: ${heuristicLine}`);
  } else {
    console.log(
      styleText(
        'yellow',
        `factory: real subscription usage unavailable — falling back to a rough list-price proxy, not the real subscription limit`,
      ),
    );
    console.log(heuristicLine);
  }
}

function warnQueueDiagnostics(diagnostics: QueueDiagnostic[]): void {
  for (const d of diagnostics) {
    console.error(styleText('yellow', `factory: queue ${d.message} — skipped`));
  }
}

/** GitHub is polled far less often than local files: a queue changes on the order of minutes. */
const TUI_GITHUB_QUEUE_POLL_MS = 30_000;

/** The Queue tab's backlog source for `factory tui` (#1362). Mirrors `factory run`: GitHub Issues
 *  by default, the local queue file only under `--local-queue`. Never throws at build time — a
 *  missing repo or token becomes a snapshot error the tab renders, so the TUI still starts.
 *
 *  The token is resolved here, before Ink takes the terminal, so the `gh auth token` subprocess
 *  never runs inside the first poll. Octokit is built at most once and only on the GitHub path;
 *  when no token is present at startup, each poll re-resolves it so a `gh auth login` in another
 *  terminal is picked up without restarting the TUI. */
export function tuiQueueReader(input: {
  localQueue: boolean;
  queueFile: string;
  queueProposedFile: string;
  repo: string | undefined;
  token?: () => string | undefined;
  octokit?: (token: string) => Octokit;
}): QueueReader {
  // Capture the invocation's shell and octokit seams: read() polls after main() has restored the module default.
  const shell = shellOps;
  const injectedOctokit = octokitFactory;
  const defaultOctokit = injectedOctokit ? () => injectedOctokit() : createFactoryOctokit;
  const { token: resolveToken = () => resolveGitHubToken(shell), octokit = defaultOctokit } = input;
  if (input.localQueue) {
    return { source: 'local file', read: () => readQueue(input.queueFile, input.queueProposedFile) };
  }
  if (input.repo === undefined) {
    return {
      source: 'GitHub',
      pollMs: TUI_GITHUB_QUEUE_POLL_MS,
      read: async () => ({ entries: [], error: 'repo detection failed — run inside a GitHub-backed checkout' }),
    };
  }
  const [owner, repoName] = input.repo.split('/');
  const clientFor = (token: string | undefined): ReturnType<typeof createOctokitQueueClient> | undefined =>
    token === undefined ? undefined : createOctokitQueueClient(octokit(token));
  let client = clientFor(resolveToken());
  return {
    source: 'GitHub',
    pollMs: TUI_GITHUB_QUEUE_POLL_MS,
    read: async () => {
      client ??= clientFor(resolveToken());
      if (client === undefined) return { entries: [], error: 'no GitHub token — run `gh auth login`' };
      return readGithubQueueSnapshot({ client, owner, repo: repoName });
    },
  };
}

async function cmdTui(opts: { localQueue?: boolean } = {}, runTuiImpl: typeof runTui = runTui) {
  const repoRoot = await getRepoRoot();
  const paths = getFactoryPaths(repoRoot);
  let repo: string | undefined;
  try {
    repo = await getGitHubRepo();
  } catch {
    // header just omits the repo
  }

  const repoConfig = configLoaders.loadRepoConfig(repoRoot);
  const modelsConfig = applyRepoConfig(configLoaders.loadModelsConfig(), repoConfig);
  const routesConfig = configLoaders.loadRoutesConfig();
  const effective = resolveEffectiveConfig(repoConfig);
  const router = new coreOps.ModelRouter(
    modelsConfig,
    routesConfig,
    false,
    undefined,
    effective.allowExperimental,
    effective.localOnly,
  );
  router.setLocalAuthSink?.(recordLocalAuthFailure);
  const effectiveConfigLines = describeEffectiveConfig({
    router,
    repo: repoConfig,
    repoConfigPath: '.factory/config.json',
    mergePolicy: resolveMergePolicy(configLoaders.loadFactoryConfigForRepo(paths.config), process.env, {
      auto: readRunFlagOverrides(paths.runFlags).autoMerge,
    }),
    prClassifier: resolvePrClassifierPolicy(configLoaders.loadFactoryConfigForRepo(paths.config), process.env, {
      classifier: readRunFlagOverrides(paths.runFlags).prClassifier,
    }),
  });

  await runTuiImpl({
    eventsFile: paths.events,
    repo,
    stopFile: paths.stop,
    queueReader: tuiQueueReader({
      localQueue: opts.localQueue === true,
      queueFile: paths.queue,
      queueProposedFile: paths.queueProposed,
      repo,
    }),
    costsFile: paths.costs,
    approvalsDir: paths.approvals,
    steeringDir: paths.steering,
    runsDir: paths.runs,
    breakerFile: paths.breaker,
    effectiveConfigLines,
  });
}

export type { ParkReason, RunOutcome } from '@on-par/factory-core';
export { parkEvents, parkReasonFor } from '@on-par/factory-core';

export class LaneParkError extends Error {
  readonly outcome: Extract<RunOutcome, { state: 'parked' }>;

  constructor(message: string, reason: ParkReason, failure?: { failureSignature?: string; failingChecks?: string[] }) {
    super(message);
    this.outcome = {
      state: 'parked',
      reason,
      ...(failure?.failureSignature !== undefined ? { failureSignature: failure.failureSignature } : {}),
      ...(failure?.failingChecks !== undefined ? { failingChecks: failure.failingChecks } : {}),
    };
  }

  get reason(): ParkReason {
    return this.outcome.reason;
  }

  get failureSignature(): string | undefined {
    return this.outcome.failureSignature;
  }

  get failingChecks(): string[] | undefined {
    return this.outcome.failingChecks;
  }
}

/** CHECK found every failing checker also failing on the base SHA (#1928): the issue is
 *  released to queued (not parked) and the lane pauses. */
export class LaneEnvironmentPauseError extends Error {
  readonly baseSha: string;
  readonly failingChecks: string[];
  readonly failureSignature?: string;
  /** BUILD output was kept for `factory resume --from check` (#2564); runLane must not reap it. */
  readonly buildPreserved?: boolean;

  constructor(
    message: string,
    failure: { baseSha: string; failingChecks: string[]; failureSignature?: string; buildPreserved?: boolean },
  ) {
    super(message);
    if (failure.buildPreserved !== undefined) this.buildPreserved = failure.buildPreserved;
    this.baseSha = failure.baseSha;
    this.failingChecks = failure.failingChecks;
    if (failure.failureSignature !== undefined) this.failureSignature = failure.failureSignature;
  }
}

/** Resolves the stable lane URL a build/check agent should use, by probing whether
 *  a factory proxy (started by `factory run`/`supervise` or `factory proxy`) is
 *  currently alive for the configured domain. Never throws — an absent/dead proxy
 *  just degrades to the existing port-based URL, single informational note either way. */
export function resolveLaneBaseUrl(
  paths: ReturnType<typeof getFactoryPaths>,
  settings: EnvironmentProxySettings,
  worktree: string,
  appPort: number | undefined,
  deps: { isRunning?: typeof isProxyRunning } = {},
): { baseUrl?: string; note: string } {
  const { isRunning = isProxyRunning } = deps;
  if (!settings.enabled || appPort === undefined) return { note: '' };

  const state = isRunning(paths.proxyState);
  if (state && state.domain === settings.domain) {
    const baseUrl = laneBaseUrl(worktree, { domain: state.domain, port: state.port });
    return { baseUrl, note: `stable lane URL ${baseUrl} -> 127.0.0.1:${appPort}` };
  }
  return { note: `proxy enabled but not running — using http://127.0.0.1:${appPort}` };
}

/** Builds the port-lease acquirer passed to runIssue, or undefined to skip it. A
 *  docker-sandbox lane runs inside its own microVM network namespace and binds its
 *  normal port there, so it needs no host port-lease and (since the proxy resolves
 *  routes solely from the lease registry) no proxy route either — every other
 *  runtime keeps acquiring a lease exactly as before. */
export function resolveEnvironmentAcquirer(opts: {
  laneSandboxRuntime: SandboxRuntime;
  paths: ReturnType<typeof getFactoryPaths>;
  worktree: string;
  branch: string;
  range: [number, number];
  processGroupGraceMs: number;
  log: (type: EventKind, msg: string) => void;
  findPortListeners?: typeof defaultFindPortListeners;
  reapOrphanProcesses?: typeof reapOrphanProcesses;
}): (() => Promise<Environment>) | undefined {
  const findPortListeners = opts.findPortListeners ?? coreOps.defaultFindPortListeners;
  const reapProcesses = opts.reapOrphanProcesses ?? coreOps.reapOrphanProcesses;
  if (opts.laneSandboxRuntime === 'docker-sandbox') {
    opts.log(
      'environment_lease',
      `docker-sandbox lane ${opts.worktree} binds its port inside its own microVM — skipping host port-lease`,
    );
    return undefined;
  }

  return async (): Promise<Environment> => {
    const reaped: ReapedLease[] = [];
    const lease = await acquirePortLease({
      registryFile: opts.paths.ports,
      lockDir: opts.paths.portsLock,
      worktreeId: opts.worktree,
      branch: opts.branch,
      range: opts.range,
      onReap: (r) => {
        reaped.push(r);
        opts.log(
          'environment_lease_reaped',
          `reaped stale lease: port ${r.lease.port}, pid ${r.lease.pid}, worktree ${r.lease.worktreeId} — reason: ${r.reason}`,
        );
      },
      onPortConflict: (port) => {
        void findPortListeners(port)
          .then((listeners) => {
            const detail =
              listeners.length > 0
                ? listeners.map((l) => `pid ${l.pid} (${l.command})`).join(', ')
                : 'no listener details available';
            opts.log(
              'environment_conflict',
              `port ${port} busy but unleased — reported as conflict, not terminated: ${detail}`,
            );
          })
          .catch(() => {
            opts.log('environment_conflict', `port ${port} busy but unleased — reported as conflict, not terminated`);
          });
      },
    });
    opts.log('environment_lease', `leased port ${lease.port} for worktree ${opts.worktree}`);
    if (reaped.length > 0) {
      await reapProcesses({
        reaped,
        graceMs: opts.processGroupGraceMs,
        onEvent: (e) =>
          opts.log(
            'environment_orphan',
            `${e.action === 'killed' ? 'killed' : 'found'} pid ${e.pid} (pgid ${e.pgid}, ${e.command}) squatting port ${e.port} of dead lane ${e.worktreeId}${e.action === 'reported' ? ' — not factory-started, left running' : ''}`,
          ),
      });
    }
    return {
      port: lease.port,
      env: () => laneEnv(lease.port, process.env),
      recordPgid(pgid: number): void {
        void recordLeasePgid({
          registryFile: opts.paths.ports,
          lockDir: opts.paths.portsLock,
          worktreeId: opts.worktree,
          pgid,
        }).catch(() => {});
      },
      async release(): Promise<void> {
        await releasePortLease({
          registryFile: opts.paths.ports,
          lockDir: opts.paths.portsLock,
          worktreeId: opts.worktree,
        });
      },
    };
  };
}

/** The autoGcOnRun-gated worktree sweep every pipeline entry point runs before shipping
 *  (`factory run`, and since #1756 the one-shot `factory ship` / `factory run-issue`). Never
 *  throws — a GC failure is a warn, never a reason to abort the command. */
async function runAutoWorktreeGc(
  repoRoot: string,
  paths: ReturnType<typeof getFactoryPaths>,
  ghRepo: string,
  eventScope: string | number,
): Promise<void> {
  try {
    const factoryConfig = configLoaders.loadFactoryConfigForRepo(paths.config);
    if (!factoryConfig.worktree.autoGcOnRun) return;
    const gcLog = (type: EventKind, msg: string) => logEvent(paths.events, type, '-', msg);
    const gcSandbox = gcWorktreeSandbox(factoryConfig.sandbox, repoRoot);
    const report = await withGitLock(repoRoot, () =>
      withFileLock(paths.gitLock, () =>
        internalOps.sweepWorktrees(
          {
            repoRoot,
            ttlDays: factoryConfig.worktree.gcTtlDays,
            repo: ghRepo,
            branchPrefix: resolveBranchPrefix(),
          },
          { log: gcLog, octokit: getOctokit(), sandbox: gcSandbox },
        ),
      ),
    );
    logEvent(
      paths.events,
      'worktree-gc',
      eventScope,
      `removed ${report.removed.length} stale worktree(s), kept ${report.kept}`,
    );
    console.log(internalOps.formatGcReport(report));
  } catch (err: any) {
    logEvent(paths.events, 'warn', eventScope, `worktree gc failed: ${err.message}`);
  }
}

export interface LaneGcDeps {
  loadConfig?: (configPath: string) => Pick<FactoryConfig, 'worktree' | 'sandbox'>;
  sweep?: typeof sweepWorktrees;
  emitEvent?: typeof logEvent;
  octokit?: () => NonNullable<Parameters<typeof sweepWorktrees>[1]>['octokit'];
}

/** Mid-run worktree GC between issues in a lane (#1757). Honors worktree.autoGcOnRun, holds
 *  the git + file locks every worktree mutation holds, and skips (never waits) when another
 *  lane holds the land lock so a sweep can never race a merge. Logs worktree-gc only when it
 *  removed something. Never throws. */
export async function sweepBetweenLaneIssues(
  issue: number,
  lane: string,
  repoRoot: string,
  ghRepo: string,
  paths: ReturnType<typeof getFactoryPaths>,
  deps: LaneGcDeps = {},
): Promise<'disabled' | 'land-in-progress' | 'swept' | 'failed'> {
  const {
    loadConfig = configLoaders.loadFactoryConfigForRepo,
    sweep = internalOps.sweepWorktrees,
    emitEvent = logEvent,
    octokit = getOctokit,
  } = deps;
  try {
    const cfg = loadConfig(paths.config);
    if (!cfg.worktree.autoGcOnRun) return 'disabled';
    const gcLog = (type: EventKind, msg: string) => emitEvent(paths.events, type, issue, msg, { lane });
    const sandbox = gcWorktreeSandbox(cfg.sandbox, repoRoot);
    const report = await withGitLock(repoRoot, () =>
      withFileLock(
        paths.mergeLock,
        () =>
          withFileLock(paths.gitLock, () =>
            sweep(
              { repoRoot, ttlDays: cfg.worktree.gcTtlDays, repo: ghRepo, branchPrefix: resolveBranchPrefix() },
              { log: gcLog, octokit: octokit(), sandbox },
            ),
          ),
        { timeoutMs: 0 },
      ),
    );
    if (report.removed.length > 0) {
      emitEvent(
        paths.events,
        'worktree-gc',
        issue,
        `removed ${report.removed.length} stale worktree(s), kept ${report.kept}`,
        { lane },
      );
      console.log(internalOps.formatGcReport(report));
    }
    return 'swept';
  } catch (err: any) {
    // A zero-timeout merge-lock acquire failing means another lane is mid-land: skip quietly.
    if (err?.reason === 'timeout') return 'land-in-progress';
    emitEvent(paths.events, 'warn', issue, `mid-run worktree gc failed: ${err?.message ?? String(err)}`, { lane });
    return 'failed';
  }
}

async function cmdShip(
  issueNum: number,
  opts: {
    product?: string;
    autoRework?: boolean;
    interactive?: boolean;
    sandbox?: boolean;
    approvePlan?: boolean;
    branchPrefix?: string;
  },
) {
  if (availableAgentClis(coreOps.isCommandAvailable).length === 0) {
    throw new CliExitError(`factory: ${missingAgentCliMessage()}`, 2);
  }
  const repoRoot = await getRepoRoot();
  const paths = getFactoryPaths(repoRoot);
  if (!existsSync(paths.root)) {
    throw new CliExitError(`factory: ${notInitializedMessage()}`, 2);
  }

  const mergeNotice = mergeScopeNotice(process.env, issueNum);
  if (mergeNotice) {
    console.error(styleText('yellow', mergeNotice));
    logEvent(paths.events, 'warn', issueNum, mergeNotice);
  }

  const branchPrefix = branchPrefixOrExit(opts.branchPrefix);

  return withRepoRunLock(paths, 'factory ship', async () => {
    let ghRepo: string | null = null;
    try {
      ghRepo = await getGitHubRepo();
    } catch {
      /* shipIssue reports repo resolution itself */
    }
    if (ghRepo) await runAutoWorktreeGc(repoRoot, paths, ghRepo, issueNum);

    const priorEvents = existsSync(paths.events) ? readEvents(paths.events) : [];
    if (hasUnresolvedPark(priorEvents, String(issueNum))) {
      logEvent(paths.events, 'human-restarted', issueNum, 'manual retry of a previously parked/failed run', {
        actor: process.env.FACTORY_ACTOR ?? process.env.USER ?? 'unknown',
      });
    }

    try {
      return await shipIssue(issueNum, { ...opts, branchPrefix });
    } catch (err: any) {
      if (err instanceof IssueSkippedError) return;
      // #2492: a pull request number is a usage error, not a failed ship.
      if (err instanceof InvalidWorkRequestInputError) throw new CliExitError(`factory: ${err.message}`, 2);
      throw new CliExitError(`Ship failed for issue #${issueNum}: ${err.message}`, 1);
    }
  });
}

async function cmdRunIssue(
  issueNum: number,
  opts: {
    product?: string;
    autoRework?: boolean;
    interactive?: boolean;
    sandbox?: boolean;
    approvePlan?: boolean;
    branchPrefix?: string;
    runChildren?: boolean;
    sizeGate?: string;
    maxSlices?: string;
  },
) {
  if (availableAgentClis(coreOps.isCommandAvailable).length === 0) {
    throw new CliExitError(`factory: ${missingAgentCliMessage()}`, 2);
  }
  const repoRoot = await getRepoRoot();
  const paths = getFactoryPaths(repoRoot);
  if (!existsSync(paths.root)) {
    throw new CliExitError(`factory: ${notInitializedMessage()}`, 2);
  }

  const { runChildren, sizeGate: rawSizeGate, maxSlices: rawMaxSlices, ...shipOpts } = opts;
  const branchPrefix = branchPrefixOrExit(opts.branchPrefix);
  const sizeGate = sizeGateOrExit(rawSizeGate);
  const maxSlices = maxSlicesOrExit(rawMaxSlices);

  await withRepoRunLock(paths, 'factory run-issue', async () => {
    const ghRepo = await getGitHubRepo();

    // Pre-flight: resolve the issue through the canonical work-request seam
    // BEFORE any worktree or PR exists — a bad issue exits here.
    const workSources = createDefaultWorkSourceRegistry({ octokit: getOctokit() });
    let work: WorkRequest;
    try {
      work = await workSources.resolve(GITHUB_ISSUE_SOURCE, {
        repo: ghRepo,
        issue: issueNum,
      } satisfies GithubIssueParams);
    } catch (err) {
      if (err instanceof InvalidWorkRequestInputError) {
        throw new CliExitError(`factory: ${err.message}`, 2);
      }
      throw new CliExitError(
        `factory: could not resolve issue #${issueNum} in ${ghRepo} (${errorDetail(err)}) — no worktree or PR was created`,
        2,
      );
    }
    console.log(styleText('cyan', `one-shot: resolved ${work.id} — running the pipeline (queue untouched)`));
    await runAutoWorktreeGc(repoRoot, paths, ghRepo, issueNum);

    const priorEvents = existsSync(paths.events) ? readEvents(paths.events) : [];
    if (hasUnresolvedPark(priorEvents, String(issueNum))) {
      logEvent(paths.events, 'human-restarted', issueNum, 'manual retry of a previously parked/failed run', {
        actor: process.env.FACTORY_ACTOR ?? process.env.USER ?? 'unknown',
      });
    }

    try {
      await shipIssue(
        issueNum,
        { ...shipOpts, branchPrefix, sizeGate, maxSlices },
        { repoRoot, ghRepo, workRequest: work },
      );
    } catch (err: any) {
      if (err instanceof IssueSkippedError) return;
      if (err instanceof IssueDecomposedError && runChildren) {
        await runDecomposedChildren(
          issueNum,
          err.childIssues,
          { ...shipOpts, branchPrefix, sizeGate, maxSlices },
          { repoRoot, ghRepo, workSources },
        );
        return;
      }
      if (err instanceof IssueDecomposedError && !runChildren) {
        const children = err.childIssues.map((n) => `#${n}`).join(', ');
        throw new CliExitError(
          `Run failed for issue #${issueNum}: the size gate decomposed it into ${children} — no child issue was run. ` +
            `Re-run with \`factory run-issue ${issueNum} --run-children\` to run them.`,
          1,
        );
      }
      throw new CliExitError(`Run failed for issue #${issueNum}: ${err.message}`, 1);
    }
  });
}

/** Runs each decomposed child through the one-shot pipeline in build order, inside the caller's
 *  run lock, then prints a per-child summary. Nested decompositions expand in place and closed
 *  children are skipped. A failed or escalated child is recorded and the next one still runs;
 *  `.factory/STOP` is checked before each child starts (read only, ADR-0111). Throws CliExitError(1)
 *  unless every child is ready or skipped (#1747, #1748, #1749). */
async function runDecomposedChildren(
  parent: number,
  children: readonly number[],
  opts: Parameters<typeof shipIssue>[1],
  env: { repoRoot: string; ghRepo: string; workSources: ReturnType<typeof createDefaultWorkSourceRegistry> },
): Promise<void> {
  const list = children.map((n) => `#${n}`).join(', ');
  console.log(styleText('cyan', `run-children: #${parent} decomposed into ${list} — running them in build order`));
  const paths = getFactoryPaths(env.repoRoot);
  const results = await runChildrenInOrder(
    children,
    async (child): Promise<ChildRunResult> => {
      let work: WorkRequest;
      try {
        work = await env.workSources.resolve(GITHUB_ISSUE_SOURCE, {
          repo: env.ghRepo,
          issue: child,
        } satisfies GithubIssueParams);
      } catch (err) {
        return { issue: child, status: 'failed', detail: `could not resolve issue #${child} (${errorDetail(err)})` };
      }
      console.log(styleText('cyan', `one-shot: resolved ${work.id} — running the pipeline (queue untouched)`));
      let outcome: RunOutcome | undefined;
      try {
        await shipIssue(child, opts, {
          repoRoot: env.repoRoot,
          ghRepo: env.ghRepo,
          workRequest: work,
          onOutcome: (o) => {
            outcome = o;
          },
        });
      } catch (err: any) {
        if (err instanceof IssueDecomposedError) {
          const again = err.childIssues.map((n) => `#${n}`).join(', ');
          console.log(
            styleText('cyan', `run-children: #${child} decomposed into ${again} — running them in its place`),
          );
          return { issue: child, status: 'decomposed', children: err.childIssues };
        }
        if (err instanceof IssueSkippedError) {
          return { issue: child, status: 'skipped', detail: err.message };
        }
        return { issue: child, status: 'failed', detail: err instanceof Error ? err.message : String(err) };
      }
      const done = outcome as RunOutcome | undefined;
      return { issue: child, status: 'ready', prNumber: done && 'prNumber' in done ? done.prNumber : undefined };
    },
    [parent],
    (next) => {
      if (!existsSync(paths.stop)) return false;
      logEvent(paths.events, 'stopped', next, 'STOP file present');
      console.log(
        styleText('yellow', `run-children: .factory/STOP present — not starting #${next} or any later child`),
      );
      return true;
    },
  );
  const ok = childRunSucceeded(results);
  for (const line of formatChildRunSummary(parent, results)) {
    console.log(ok ? styleText('green', line) : styleText('yellow', line));
  }
  if (!ok) {
    throw new CliExitError(
      `Run failed for issue #${parent}: not every decomposed child reached ready-for-review or was skipped as closed (failed or not-run children are listed above)`,
      1,
    );
  }
}

async function cmdRunBrief(
  briefPath: string,
  opts: {
    product?: string;
    autoRework?: boolean;
    interactive?: boolean;
    sandbox?: boolean;
    approvePlan?: boolean;
    workspace?: string;
    artifacts?: string;
    branchPrefix?: string;
  },
) {
  if (availableAgentClis(coreOps.isCommandAvailable).length === 0) {
    throw new CliExitError(`factory: ${missingAgentCliMessage()}`, 2);
  }
  const repoRoot = await getRepoRoot();
  const paths = getFactoryPaths(repoRoot);
  if (!existsSync(paths.root)) {
    throw new CliExitError(`factory: ${notInitializedMessage()}`, 2);
  }

  const branchPrefix = branchPrefixOrExit(opts.branchPrefix);

  await withRepoRunLock(paths, 'factory run-brief', async () => {
    let localOnly: LocalOnlyPolicy | undefined;
    if (opts.workspace !== undefined) {
      try {
        localOnly = resolveLocalOnlyPolicy(opts.workspace);
      } catch (err) {
        if (err instanceof InvalidWorkspaceError) throw new CliExitError(`factory: ${err.message}`, 2);
        throw err;
      }
    }

    let artifactsDir: string | undefined;
    if (opts.artifacts !== undefined) {
      if (!localOnly) {
        throw new CliExitError('factory: --artifacts requires --workspace (local-only runs only)', 2);
      }
      try {
        artifactsDir = resolveArtifactsDir(opts.artifacts);
      } catch (err) {
        if (err instanceof InvalidArtifactsDirError) throw new CliExitError(`factory: ${err.message}`, 2);
        throw err;
      }
      console.log(styleText('cyan', `local-only: benchmark artifacts will be written to ${artifactsDir}`));
    }

    // Local-only runs never touch GitHub — no remote required, no mutation possible.
    const ghRepo = localOnly ? 'local/workspace' : await getGitHubRepo();

    // Pre-flight: resolve the brief through the canonical work-request seam
    // BEFORE any worktree or PR exists — a malformed brief exits here, so BUILD never starts.
    const workSources = createDefaultWorkSourceRegistry({ octokit: getOctokit() });
    let work: WorkRequest;
    try {
      work = await workSources.resolve(LOCAL_BRIEF_SOURCE, { path: briefPath } satisfies LocalBriefParams);
    } catch (err) {
      if (err instanceof InvalidWorkRequestInputError) {
        throw new CliExitError(`factory: ${err.message}`, 2);
      }
      throw new CliExitError(
        `factory: could not resolve brief at ${briefPath} (${errorDetail(err)}) — no worktree or PR was created`,
        2,
      );
    }
    const digest = work.reference?.externalId ?? '';
    const runNum = briefRunNumber(digest);
    console.log(styleText('cyan', `one-shot: resolved ${work.id} — running the pipeline (queue untouched)`));
    logEvent(paths.events, 'work-source', runNum, `inline local brief ${briefPath} (sha256 ${digest})`);
    if (localOnly) {
      console.log(styleText('cyan', `local-only: workspace ${localOnly.workspace} — publishing disabled`));
      logEvent(
        paths.events,
        'local-only',
        runNum,
        `caller-provided workspace ${localOnly.workspace} — publishing disabled`,
      );
    }

    const priorEvents = existsSync(paths.events) ? readEvents(paths.events) : [];
    if (hasUnresolvedPark(priorEvents, String(runNum))) {
      logEvent(paths.events, 'human-restarted', runNum, 'manual retry of a previously parked/failed run', {
        actor: process.env.FACTORY_ACTOR ?? process.env.USER ?? 'unknown',
      });
    }

    try {
      await shipIssue(
        runNum,
        { ...opts, branchPrefix },
        {
          repoRoot,
          ghRepo,
          workRequest: work,
          workSource: { kind: LOCAL_BRIEF_SOURCE, params: { path: briefPath } satisfies LocalBriefParams },
          localOnly,
          artifactsDir,
        },
      );
    } catch (err: any) {
      throw new CliExitError(`Run failed for brief ${briefPath}: ${err.message}`, 1);
    }
  });
}

async function cmdLocalSmallDryRun(issueNum: number, opts: { spec?: string; output?: string }) {
  const repoRoot = await getRepoRoot();
  const ghRepo = await getGitHubRepo();
  const paths = getFactoryPaths(repoRoot);
  const octokit = getOctokit();
  const [owner, repoName] = ghRepo.split('/');
  const specPath = resolve(repoRoot, opts.spec ?? resolve(paths.plans, `issue-${issueNum}.md`));
  const outputDir = resolve(repoRoot, opts.output ?? resolve(paths.state, 'local-small', `issue-${issueNum}`));
  const { data: issue } = await octokit.rest.issues.get({ owner, repo: repoName, issue_number: issueNum });

  const result = await internalOps.createLocalSmallDryRun({
    issue: issueNum,
    issueTitle: issue.title,
    issueBody: issue.body ?? '',
    repoRoot,
    specPath,
    outputDir,
  });

  console.log(styleText('green', `local-small dry run: ${result.planPath}`));
  console.log(styleText('green', `local-small context: ${result.contextPath}`));
}

async function cmdLocalSmallOvernight(opts: { queue?: string; state?: string }) {
  const repoRoot = await getRepoRoot();
  const paths = getFactoryPaths(repoRoot);
  const queueFile = resolve(repoRoot, opts.queue ?? resolve(paths.state, 'local-small', 'overnight-queue'));
  const statePath = resolve(repoRoot, opts.state ?? resolve(paths.state, 'local-small', 'overnight-state.json'));

  if (!existsSync(queueFile)) {
    throw new CliExitError(
      `factory: overnight queue not found at ${queueFile} — create it with "<lane> <issue#>" lines`,
      2,
    );
  }

  const { entries, diagnostics } = parseQueue(readFileSync(queueFile, 'utf-8'));
  warnQueueDiagnostics(diagnostics);
  if (entries.length === 0) {
    throw new CliExitError(`factory: overnight queue at ${queueFile} has no valid entries`, 2);
  }

  await withRepoRunLock(paths, 'factory local-small-overnight', async () => {
    const ghRepo = await getGitHubRepo();
    process.env.FACTORY_LOCAL_ONLY = '1';

    const preflight = async (): Promise<OvernightPreflightResult> => {
      if (availableAgentClis(coreOps.isCommandAvailable).length === 0)
        return { ok: false, reason: missingAgentCliMessage() };
      const registry = new coreOps.ModelRegistry(
        applyRepoConfig(configLoaders.loadModelsConfig(), configLoaders.loadRepoConfig(repoRoot)),
      );
      const diagnoses = coreOps.diagnoseModels(
        registry,
        modelDoctorProbes(),
        resolveExperimental(),
        true, // localOnly
      );
      if (!hasReachableWorker(diagnoses)) {
        const reasons = diagnoses.filter((d) => !d.reachable).map((d) => `${d.model}: ${d.reason}`);
        return { ok: false, reason: `no reachable local worker model — ${reasons.join('; ')}` };
      }
      return { ok: true };
    };

    const processItem = async (issue: number): Promise<OvernightItemOutcome> => {
      try {
        await shipIssue(issue, { autoRework: true, interactive: false }, { repoRoot, ghRepo, lane: 'overnight' });
        return { status: 'ready' };
      } catch (err: any) {
        if (err instanceof IssueSkippedError) return { status: 'parked', reason: err.message };
        return parkReasonFor(err) === 'escalate'
          ? { status: 'parked', reason: err.message }
          : { status: 'failed', reason: err.message };
      }
    };

    const report = (item: OvernightStateItem) => {
      console.log(styleText('yellow', `factory: issue #${item.issue} ${item.status} — ${item.reason ?? 'unknown'}`));
      logEvent(
        paths.events,
        'overnight-park',
        item.issue,
        `${item.status}: ${item.reason ?? 'unknown'} — see ${paths.reports}`,
      );
    };
    const log = (type: EventKind, msg: string) => logEvent(paths.events, type, '-', msg);

    const deps: OvernightQueueDeps = { preflight, processItem, report, log };
    const result = await runOvernightQueue({ issues: entries.map((e) => e.issue), statePath }, deps);

    const ready = result.processed.filter((item) => item.status === 'ready');
    const parked = result.processed.filter((item) => item.status === 'parked');
    const failed = result.processed.filter((item) => item.status === 'failed');
    console.log(styleText('green', `overnight ready: ${ready.length}`));
    console.log(styleText('yellow', `overnight parked: ${parked.length}`));
    console.log(styleText('red', `overnight failed: ${failed.length}`));
    console.log(styleText('yellow', `overnight skipped (already resumed): ${result.skipped.length}`));

    if (result.halted) {
      throw new CliExitError(
        `factory: overnight halted before issue #${result.halted.issue}: ${result.halted.reason} — fix the environment and re-run to resume`,
        4,
      );
    }
  });
}

function worktreePathFor(
  repoRoot: string,
  ghRepo: string,
  issueNum: number,
  prefix?: string,
  loaders: ConfigLoaders = configLoaders,
): string {
  return laneWorktreePath({
    repoRoot,
    parent: loaders.loadFactoryConfigForRepo(getFactoryPaths(repoRoot).config).worktree.parent,
    repo: ghRepo,
    issue: issueNum,
    prefix,
  });
}

/** Fences a whole run behind the checkout's `.factory/run.lock` (#598). A live holder is
 *  refused immediately — never queued behind a multi-hour run — and a dead holder's lock is
 *  reclaimed by withRunLock. Nested acquisition inside one process is a pass-through, so
 *  `factory supervise` can hold this across its loop. */
export async function withRepoRunLock<T>(
  paths: ReturnType<typeof getFactoryPaths>,
  command: string,
  fn: () => Promise<T>,
  deps: { runLock?: typeof withRunLock; emitEvent?: typeof logEvent } = {},
): Promise<T> {
  const { runLock = withRunLock, emitEvent = logEvent } = deps;
  try {
    return await runLock(paths.runLock, fn, {
      command,
      onReclaim: (pid) =>
        emitEvent(
          paths.events,
          'lock-stolen',
          '-',
          `reclaimed ${paths.runLock} from dead holder pid ${pid ?? 'unknown'}`,
        ),
    });
  } catch (err) {
    if (err instanceof RunLockHeldError) {
      emitEvent(paths.events, 'run_lock_conflict', '-', `${command} refused: ${err.message}`);
      throw new CliExitError(
        `factory: ${err.message} — stop that run (or wait for it to finish) before starting another. ` +
          `A dead run's lock is reclaimed automatically; remove ${paths.runLock} only if you are sure no factory run is live.`,
        2,
      );
    }
    throw err;
  }
}

/** The repo's current docker-sandbox descriptor for worktree-gc sweeps, or undefined for
 *  every other runtime/config state (including a fixture config with no `sandbox` key). */
function gcWorktreeSandbox(
  sandboxCfg: FactoryConfig['sandbox'] | undefined,
  repoRoot: string,
): WorktreeSandbox | undefined {
  if (!sandboxCfg) return undefined;
  const policy = resolveSandboxPolicy(sandboxCfg, { worktree: repoRoot, repoRoot });
  return worktreeSandboxFor(policy?.runtime);
}

/** Eagerly reaps a parked lane's own worktree inside `factory run` (#1007). All the safety
 *  gates live in reapLaneWorktree; this wrapper resolves the lane's conventional worktree
 *  path and holds the same git+file lock pairing as every other worktree mutation site. A
 *  reap failure is logged as a warn and never surfaces — parking must always succeed. */
export async function reapParkedLaneWorktree(
  issue: number,
  repoRoot: string,
  ghRepo: string,
  paths: ReturnType<typeof getFactoryPaths>,
  prefixOverride?: string,
): Promise<void> {
  try {
    const factoryConfig = configLoaders.loadFactoryConfigForRepo(paths.config);
    const branchPrefix = prefixOverride ?? resolveEffectiveConfig(configLoaders.loadRepoConfig(repoRoot)).branchPrefix;
    const worktreePath = worktreePathFor(repoRoot, ghRepo, issue, branchPrefix);
    const log = (type: EventKind, msg: string) => logEvent(paths.events, type, issue, msg);
    const sandbox = gcWorktreeSandbox(factoryConfig.sandbox, repoRoot);
    await withGitLock(repoRoot, () =>
      withFileLock(paths.gitLock, () =>
        reapLaneWorktree(repoRoot, worktreePath, { issue, branchPrefix, log, sandbox }),
      ),
    );
  } catch (err: any) {
    logEvent(paths.events, 'warn', issue, `parked-lane worktree reap failed: ${err?.message ?? String(err)}`);
  }
}

export async function cmdWorktreeGc(opts: { dryRun?: boolean; ttlDays?: string; branchPrefix?: string }) {
  const repoRoot = await getRepoRoot();
  const paths = getFactoryPaths(repoRoot);
  const factoryConfig = configLoaders.loadFactoryConfigForRepo(paths.config);
  const ttlDays = opts.ttlDays !== undefined ? Number(opts.ttlDays) : factoryConfig.worktree.gcTtlDays;
  if (!Number.isFinite(ttlDays) || ttlDays < 0) {
    throw new CliExitError('factory: --ttl-days must be a non-negative number', 2);
  }
  const branchPrefix = branchPrefixOrExit(opts.branchPrefix);
  const log = (type: EventKind, msg: string) => logEvent(paths.events, type, '-', msg);
  // Best-effort GitHub evidence: tokenless/local-only repos keep today's pure-local behavior.
  const ghRepo = await getGitHubRepo().catch(() => undefined);
  const octokit = ghRepo ? (hasGitHubToken() ? getOctokit() : undefined) : undefined;
  const sandbox = gcWorktreeSandbox(factoryConfig.sandbox, repoRoot);
  const run = () =>
    internalOps.sweepWorktrees(
      { repoRoot, ttlDays, dryRun: opts.dryRun, repo: ghRepo, branchPrefix },
      { log, octokit, sandbox },
    );
  const report = opts.dryRun ? await run() : await withGitLock(repoRoot, () => withFileLock(paths.gitLock, run));
  console.log(internalOps.formatGcReport(report));
}

/** `factory reset <issue...>` (#1787): wipes an issue's local state; see reset.ts. */
export async function cmdReset(
  issues: string[],
  opts: { branchPrefix?: string; dryRun?: boolean; force?: boolean },
): Promise<void> {
  let nums: number[];
  try {
    nums = parseResetIssues(issues);
  } catch (err: any) {
    throw new CliExitError(err.message, 2);
  }
  const repoRoot = await getRepoRoot();
  const paths = getFactoryPaths(repoRoot);
  const branchPrefix = branchPrefixOrExit(opts.branchPrefix);
  const sandbox = gcWorktreeSandbox(configLoaders.loadFactoryConfigForRepo(paths.config).sandbox, repoRoot);
  const log = (type: EventKind, msg: string) => logEvent(paths.events, type, '-', msg);
  const run = () =>
    runReset(nums, {
      repoRoot,
      cwd: process.cwd(),
      paths,
      branchPrefix,
      git: (cmd) => shellOps.exec(cmd, { cwd: repoRoot }).then((r) => r.stdout),
      removeWorktree: (p) => gitOps.cleanupWorktree(repoRoot, p, log, sandbox),
      readLeases: () => readPortLeases(paths.ports),
      releaseLease: (id) => releasePortLease({ registryFile: paths.ports, lockDir: paths.portsLock, worktreeId: id }),
      runCommand: (cmd, o) => shellOps.exec(cmd, { cwd: o?.cwd ?? repoRoot }).then((r) => ({ stdout: r.stdout })),
      dryRun: opts.dryRun === true,
      force: opts.force === true,
    });
  // A dry run takes no lock: the lock itself writes files.
  const lines = opts.dryRun ? await run() : await withGitLock(repoRoot, () => withFileLock(paths.gitLock, run));
  for (const line of lines) console.log(line);
}

/** deps overrides the config loaders, git ops, internal ops and octokit for this call, like shipIssue. */
export async function cmdLand(
  issueNum: number,
  opts: { branchPrefix?: string; allowGated?: boolean } = {},
  deps: Pick<CliDeps, ConfigLoaderKey | GitOpKey | InternalOpKey | ShellOpKey | 'octokit'> = {},
) {
  const previousLoaders = configLoaders;
  const previousOctokitFactory = octokitFactory;
  const previousGitOps = gitOps;
  const previousInternalOps = internalOps;
  const previousShellOps = shellOps;
  configLoaders = resolveConfigLoaders(deps);
  gitOps = resolveGitOps(deps);
  internalOps = resolveInternalOps(deps);
  shellOps = resolveShellOps(deps);
  octokitFactory = deps.octokit ?? octokitFactory;
  try {
    const branchPrefix = branchPrefixOrExit(opts.branchPrefix);
    const repoRoot = await getRepoRoot();
    const ghRepo = await getGitHubRepo();
    const paths = getFactoryPaths(repoRoot);
    const octokit = getOctokit();
    const factoryConfig = configLoaders.loadFactoryConfigForRepo(paths.config);
    const skipCI = configLoaders.resolveSkipCI(factoryConfig);

    try {
      const result = await landIssue(issueNum, repoRoot, ghRepo, paths, octokit, skipCI, branchPrefix, {
        allowGated: opts.allowGated === true,
      });
      console.log(styleText('green', `✅ Landed PR #${result.prNumber} for issue #${issueNum}`));
    } catch (err: any) {
      if (err instanceof AwaitingReviewError) {
        console.log(
          styleText('yellow', `⏸ PR #${err.prNumber} for issue #${issueNum} awaiting human review — left open`),
        );
        return;
      }
      if (err instanceof CiUnverifiedError) {
        console.log(
          styleText(
            'yellow',
            `⏸ PR #${err.prNumber} for issue #${issueNum} — CI never reached a green verdict — left open, not merged`,
          ),
        );
        return;
      }
      if (err instanceof CiFailedError) {
        console.log(
          styleText(
            'yellow',
            `⏸ PR #${err.prNumber} for issue #${issueNum} has a failing CI check — left open, not merged`,
          ),
        );
        return;
      }
      if (err instanceof MergeGatedError) {
        throw new CliExitError(`factory: ${err.message}`, 4);
      }
      if (err instanceof LandConflictError) {
        throw new CliExitError(`factory: ${err.message}`, 3);
      }
      if (err instanceof LandFailureError) {
        throw new CliExitError(`factory: ${err.message}`, err.code);
      }
      throw new CliExitError(`factory: merge failed for issue #${issueNum}: ${err.message}`, 5);
    }
  } finally {
    configLoaders = previousLoaders;
    gitOps = previousGitOps;
    internalOps = previousInternalOps;
    shellOps = previousShellOps;
    octokitFactory = previousOctokitFactory;
  }
}

async function cmdTriage(opts: { product?: string; model?: string }) {
  const repoRoot = await getRepoRoot();
  const ghRepo = await getGitHubRepo();
  const paths = getFactoryPaths(repoRoot);
  if (!existsSync(paths.root)) {
    throw new CliExitError(`factory: ${notInitializedMessage()}`, 2);
  }
  const product = opts.product ?? readActiveProduct(paths.product);

  const repoConfig = configLoaders.loadRepoConfig(repoRoot);
  const modelsConfig = applyRepoConfig(configLoaders.loadModelsConfig(), repoConfig);
  const routesConfig = configLoaders.loadRoutesConfig();
  const effective = resolveEffectiveConfig(repoConfig);
  const router = new coreOps.ModelRouter(
    modelsConfig,
    routesConfig,
    false,
    undefined,
    effective.allowExperimental,
    effective.localOnly,
  );
  router.setLocalAuthSink?.(recordLocalAuthFailure);
  router.skipMissingHarnessClis(coreOps.isCommandAvailable);
  router.setCostSink((entry) => logCost(paths.costs, { ...entry, issue: '-' }));

  let plannerError: unknown;
  let model: string | undefined;
  try {
    const { stdout: listed } = await shellOps.exec(
      `gh issue list --repo ${shellEscape(ghRepo)} --state open --limit 100 --json number,title,labels,body`,
    );
    const prompt = buildTriagePrompt({ repo: ghRepo, product, candidates: parseTriageCandidates(listed || '[]') });
    logEvent(paths.events, 'triage', '-', `Triaging ${ghRepo} via the triage route`);
    const result = await router.run('triage', prompt, {
      worktree: repoRoot,
      timeoutSeconds: 600,
      ...(opts.model ? { modelOverride: opts.model } : {}),
      onLog: (msg) => logEvent(paths.events, 'triage', '-', msg),
    });
    model = result.model;
    const queue = normalizeTriageQueue(result.output);
    if (queue) {
      const header = triageQueueHeader(model, product);
      writeFileSync(paths.queueProposed, header + queue);
    }
  } catch (err: unknown) {
    plannerError = err;
    logEvent(paths.events, 'warn', '-', `triage planner failed: ${errorDetail(err)}`);
  }
  if (model) logEvent(paths.events, 'triage', '-', `Triaged ${ghRepo} with ${model}`);

  const proposed = existsSync(paths.queueProposed) ? readFileSync(paths.queueProposed, 'utf-8') : '';
  const message = triageProposalMessage(proposed, paths.queueProposed, paths.queue);
  if (message) {
    console.log(message);
  } else {
    throw triageNoProposalError(plannerError);
  }
}

export function triageQueueHeader(model: string | undefined, product: string | null | undefined): string {
  return `# Triage queue (model ${model}${product ? `, constitution ${product}` : ''})\n`;
}

export function triageProposalMessage(proposed: string, proposedPath: string, queuePath: string): string | null {
  if (!proposed.trim()) return null;
  return `${proposed}\n---\nreview and run: factory triage accept   (promotes ${proposedPath} -> ${queuePath})`;
}

export async function cmdTriageAccept(opts: { force?: boolean }) {
  const repoRoot = await getRepoRoot();
  const paths = getFactoryPaths(repoRoot);

  if (!existsSync(paths.queueProposed)) {
    console.log(`nothing to accept: ${paths.queueProposed} not found`);
    return; // zero exit
  }

  const content = readFileSync(paths.queueProposed, 'utf-8');
  const result = validateQueue(content);

  if (!opts.force && !result.ok) {
    throw new CliExitError(
      `factory: proposed queue is invalid: ${paths.queueProposed} left unchanged\n` +
        result.errors.map((e) => `  - ${e}`).join('\n'),
      1,
    );
  }

  renameSync(paths.queueProposed, paths.queue); // same dir → atomic

  let acceptedBy = 'unknown';
  try {
    acceptedBy = userInfo().username;
  } catch {
    /* keep 'unknown' */
  }
  const suffix = opts.force ? ' (--force, validation skipped)' : '';
  logEvent(
    paths.events,
    'triage_accepted',
    '-',
    `accepted ${result.issues.length} issue(s) [${result.issues.join(', ')}] by ${acceptedBy}${suffix}`,
  );
  console.log(styleText('green', `queue accepted: ${result.issues.length} issue(s) promoted to ${paths.queue}`));
}

export async function cmdQueueMigrate(opts: { file?: string; dryRun?: boolean } = {}): Promise<void> {
  const repoRoot = await getRepoRoot();
  const paths = getFactoryPaths(repoRoot);
  const queueFile = opts.file ? resolve(repoRoot, opts.file) : paths.queue;

  if (!existsSync(queueFile)) {
    throw new CliExitError(
      `factory: queue not found at ${queueFile} — run factory init + triage first, or pass --file`,
      2,
    );
  }

  const { entries, diagnostics } = parseQueue(readFileSync(queueFile, 'utf-8'));

  // Stage 1 — structural problems, reported before any GitHub call.
  const structural: string[] = diagnostics.map((d) => d.message);
  const firstLineFor = new Map<number, number>();
  for (const entry of entries) {
    const first = firstLineFor.get(entry.issue);
    if (first !== undefined) {
      structural.push(`line ${entry.lineNo}: duplicate issue #${entry.issue} (already queued at line ${first})`);
    } else {
      firstLineFor.set(entry.issue, entry.lineNo);
    }
  }
  if (entries.length === 0 && structural.length === 0) {
    structural.push('queue has no issue entries');
  }
  if (structural.length > 0) {
    throw new CliExitError(
      `factory: queue is invalid — ${queueFile} left unchanged\n` + structural.map((p) => `  - ${p}`).join('\n'),
      1,
    );
  }

  // Stage 2 — GitHub preflight (read-only). Any closed/PR/inaccessible entry aborts all.
  const [owner, repo] = (await getGitHubRepo()).split('/');
  const octokit = getOctokit();
  const unreachable: string[] = [];
  for (const entry of entries) {
    try {
      const { data } = await octokit.rest.issues.get({ owner, repo, issue_number: entry.issue });
      if (data.pull_request) {
        unreachable.push(`line ${entry.lineNo}: #${entry.issue} is a pull request, not an issue`);
      } else if (data.state === 'closed') {
        unreachable.push(`line ${entry.lineNo}: issue #${entry.issue} is closed — cannot queue`);
      }
    } catch (err) {
      unreachable.push(`line ${entry.lineNo}: issue #${entry.issue} is inaccessible — ${errorDetail(err)}`);
    }
  }
  if (unreachable.length > 0) {
    throw new CliExitError(
      `factory: queue migration aborted — ${unreachable.length} issue(s) cannot be migrated; no labels applied\n` +
        unreachable.map((p) => `  - ${p}`).join('\n'),
      1,
    );
  }

  const plan = planQueueMigration(entries);

  if (opts.dryRun) {
    console.log(
      styleText(
        'cyan',
        `dry run — ${plan.length} issue(s) would be labelled from ${queueFile}; no GitHub changes made`,
      ),
    );
    for (const step of plan) {
      console.log(`  #${step.issue} → lane ${step.lane}, position ${step.position} [${step.labels.join(', ')}]`);
    }
    return;
  }

  const queue = createGithubQueue({ client: createOctokitQueueClient(octokit), owner, repo });
  try {
    await queue.migrateLocalQueue(entries);
  } catch (err) {
    throw new CliExitError(`factory: queue migration failed — ${errorDetail(err)}`, 1);
  }
  console.log(styleText('green', `queue migrated — ${entries.length} issue(s) labelled from ${queueFile}`));
}

/** Append one `queue_added` event for newly queued issues; the silent sink keeps stdout untouched. */
async function recordQueueAdded(lane: string, results: readonly EnqueueResult[]): Promise<void> {
  const queued = results.filter((r) => r.outcome === 'queued');
  if (queued.length === 0) return;
  try {
    const eventsFile = getFactoryPaths(await getRepoRoot()).events;
    const summary = queued.map((r) => `#${r.issue} (order ${r.position})`).join(', ');
    createLogger(eventsFile, { lane }, { out: { write: () => true } }).info(
      'queue_added',
      `${lane}: ${summary} queued`,
    );
  } catch (err) {
    console.error(styleText('yellow', `factory: queue add event not recorded — ${errorDetail(err)}`));
  }
}

/** Append one `issue_unparked` event; the silent sink keeps stdout untouched. */
async function recordIssueUnparked(result: UnparkJson): Promise<void> {
  try {
    const eventsFile = getFactoryPaths(await getRepoRoot()).events;
    createLogger(eventsFile, { lane: result.lane, issue: result.issue }, { out: { write: () => true } }).info(
      'issue_unparked',
      `#${result.issue} unparked → ${result.lane} (order ${result.order})`,
    );
  } catch (err) {
    console.error(styleText('yellow', `factory: unpark event not recorded — ${errorDetail(err)}`));
  }
}

export async function cmdUnpark(issueArg: string, opts: { lane?: string; json?: boolean } = {}): Promise<void> {
  const issue = parseIssueArg(issueArg);
  let result: UnparkJson;
  try {
    const [owner, repo] = (await getGitHubRepo()).split('/');
    result = await runUnpark({
      client: createOctokitQueueClient(getOctokit()),
      owner,
      repo,
      issue,
      ...(opts.lane === undefined ? {} : { lane: opts.lane }),
    });
  } catch (err) {
    const code = err instanceof UnparkError ? err.code : 'unpark-failed';
    throw new CliExitError(`factory: unpark #${issue} [${code}] — ${errorDetail(err)}`, 1);
  }
  await recordIssueUnparked(result);
  if (opts.json) {
    console.log(JSON.stringify(result));
    return;
  }
  console.log(styleText('green', `#${issue} unparked → lane ${result.lane}, position ${result.order}`));
}

export async function cmdQueueAdd(lane: string, issueArgs: string[], opts: { json?: boolean } = {}): Promise<void> {
  // Validate + dedupe BEFORE any GitHub call. parseIssueArg throws CliExitError(2) on bad input.
  const seen = new Set<number>();
  const issues: number[] = [];
  for (const raw of issueArgs) {
    const n = parseIssueArg(raw);
    if (!seen.has(n)) {
      seen.add(n);
      issues.push(n);
    }
  }

  const enqueueAll = async (): Promise<EnqueueResult[]> => {
    const [owner, repo] = (await getGitHubRepo()).split('/');
    const queue = createGithubQueue({ client: createOctokitQueueClient(getOctokit()), owner, repo });
    return queue.enqueue(lane, issues);
  };
  let results: EnqueueResult[];
  if (opts.json) {
    try {
      results = await enqueueAll();
    } catch (err) {
      throw new CliExitError(`factory: queue add failed — ${errorDetail(err)}`, 1);
    }
  } else {
    results = await enqueueAll();
  }

  await recordQueueAdded(lane, results);

  if (opts.json) {
    console.log(JSON.stringify(buildQueueAddJson(lane, results)));
    const failedJson = results.filter((r) => r.outcome === 'failed');
    if (failedJson.length > 0) {
      throw new CliExitError(`factory: ${failedJson.length} issue(s) failed to queue`, 1);
    }
    return;
  }

  for (const r of results) {
    if (r.outcome === 'queued') {
      console.log(styleText('green', `#${r.issue} queued → lane ${lane}, position ${r.position}`));
    } else if (r.outcome === 'already-queued') {
      console.log(`#${r.issue} already queued — skipped`);
    } else {
      console.error(styleText('red', `#${r.issue} failed — ${r.detail}`));
    }
  }

  const failed = results.filter((r) => r.outcome === 'failed');
  if (failed.length > 0) {
    throw new CliExitError(`factory: ${failed.length} issue(s) failed to queue`, 1);
  }
}

export async function cmdQueueReconcile(opts: { lane?: string } = {}): Promise<void> {
  const repoRoot = await getRepoRoot();
  const paths = getFactoryPaths(repoRoot);
  const [owner, repo] = (await getGitHubRepo()).split('/');
  const client = createOctokitQueueClient(getOctokit());
  const { report, conflicts } = await runQueueReconcile({
    readSnapshot: () => readGithubQueueSnapshot({ client, owner, repo }),
    reader: admissionStateReaderFor(paths.state),
    ...(opts.lane === undefined ? {} : { lane: opts.lane }),
  });
  console.log(report);
  if (conflicts > 0) {
    throw new CliExitError(`factory: ${conflicts} queued issue(s) conflict with Factory App admission state`, 1);
  }
}

export async function cmdQueueList(opts: { json?: boolean; lane?: string } = {}): Promise<void> {
  if (!opts.json) throw new CliExitError('factory: queue list requires --json', 2);
  const [owner, repo] = (await getGitHubRepo()).split('/');
  let snapshot: Awaited<ReturnType<typeof readGithubQueueSnapshot>>;
  try {
    snapshot = await readGithubQueueSnapshot({ client: createOctokitQueueClient(getOctokit()), owner, repo });
  } catch (err) {
    throw new CliExitError(`factory: queue list failed — ${errorDetail(err)}`, 1);
  }
  console.log(JSON.stringify(buildQueueListJson(snapshot, opts.lane)));
}

export async function cmdRuns(opts: { json?: boolean; limit?: string; diffstat?: string } = {}): Promise<void> {
  if (!opts.json) throw new CliExitError('factory: runs requires --json', 2);
  if (opts.diffstat !== undefined) {
    if (opts.limit !== undefined) {
      throw new CliExitError('factory: runs — --diffstat and --limit cannot be combined', 2);
    }
    let issue: number;
    try {
      issue = parseDiffstatIssue(opts.diffstat);
    } catch (err) {
      throw new CliExitError(`factory: runs — ${errorDetail(err)}`, 2);
    }
    const repoRoot = await getRepoRoot();
    let out: RunDiffstatJson;
    try {
      out = await buildRunDiffstatJson({ runsDir: getFactoryPaths(repoRoot).runs, repoRoot, issue });
    } catch (err) {
      if (err instanceof NoRunError) throw new CliExitError(`factory: runs — ${err.message}`, 1);
      throw new CliExitError(`factory: runs failed — ${errorDetail(err)}`, 1);
    }
    console.log(JSON.stringify(out));
    return;
  }
  let limit: number;
  try {
    limit = parseRunsLimit(opts.limit);
  } catch (err) {
    throw new CliExitError(`factory: runs — ${errorDetail(err)}`, 2);
  }
  const paths = getFactoryPaths(await getRepoRoot());
  let result: Awaited<ReturnType<typeof buildRunsJson>>;
  try {
    result = await buildRunsJson(paths.runs, { limit });
  } catch (err) {
    throw new CliExitError(`factory: runs failed — ${errorDetail(err)}`, 1);
  }
  for (const note of result.skipped) console.error(note);
  console.log(JSON.stringify(result.json));
}

export async function cmdQueueClear(opts: { dryRun?: boolean; yes?: boolean; lane?: string } = {}): Promise<void> {
  const [owner, repo] = (await getGitHubRepo()).split('/');
  const queue = createGithubQueue({ client: createOctokitQueueClient(getOctokit()), owner, repo });
  const { report, exitCode, message } = await runQueueClear({
    previewClear: () => queue.previewClear(opts.lane),
    clear: () => queue.clear(opts.lane),
    ...(opts.dryRun === undefined ? {} : { dryRun: opts.dryRun }),
    ...(opts.yes === undefined ? {} : { yes: opts.yes }),
    ...(opts.lane === undefined ? {} : { lane: opts.lane }),
  });
  console.log(report);
  if (exitCode !== 0) throw new CliExitError(message ?? 'factory: queue clear refused', exitCode);
}

export function triageNoProposalError(plannerError: unknown): CliExitError {
  const detail = plannerError ? ` — planner failed: ${errorDetail(plannerError)}` : '';
  return new CliExitError(`triage produced no proposal${detail}`, 1);
}

/** Starts the in-process lane proxy for `factory run`/`supervise` when
 *  `environment.proxy.enabled`. Never throws: a bind failure (EACCES on :80,
 *  EADDRINUSE, …) is logged as a single `environment_proxy_unavailable` event
 *  and lanes degrade to port-based URLs, exactly as if the proxy were disabled. */
export async function startLaneProxy(
  paths: ReturnType<typeof getFactoryPaths>,
  settings: EnvironmentProxySettings,
  deps: { createProxy?: typeof createLaneProxy; emitEvent?: typeof logEvent } = {},
): Promise<{ proxy?: LaneProxy }> {
  if (!settings.enabled) return {};
  const { createProxy = createLaneProxy, emitEvent = logEvent } = deps;

  const proxy = createProxy({ registryFile: paths.ports, domain: settings.domain, port: settings.port });
  try {
    const boundPort = await proxy.start();
    writeProxyState(paths.proxyState, {
      version: 1,
      pid: process.pid,
      port: boundPort,
      domain: settings.domain,
      startedAt: new Date().toISOString(),
    });
    emitEvent(
      paths.events,
      'environment_proxy',
      'all',
      `lane proxy listening on 127.0.0.1:${boundPort} (*.${settings.domain})`,
    );
    return { proxy };
  } catch (err: any) {
    emitEvent(
      paths.events,
      'environment_proxy_unavailable',
      'all',
      `proxy unavailable (${err.message}) — lanes use port-based URLs`,
    );
    return {};
  }
}

/** Runs the lane proxy in the foreground for manual use alongside single-lane
 *  `factory ship` (which only probes proxy.json and degrades — it never spawns
 *  a proxy itself). Running this command IS the opt-in: it starts even when
 *  environment.proxy.enabled is false in factory.json. */
async function cmdProxy() {
  const repoRoot = await getRepoRoot();
  const paths = getFactoryPaths(repoRoot);
  const factoryConfig = configLoaders.loadFactoryConfigForRepo(paths.config);
  const settings = resolveEnvironmentProxy(factoryConfig);

  if (!settings.enabled) {
    console.log(
      styleText(
        'yellow',
        'factory proxy: environment.proxy.enabled is false in factory.json — starting anyway (running this command is the explicit opt-in)',
      ),
    );
  }

  const proxy = createLaneProxy({ registryFile: paths.ports, domain: settings.domain, port: settings.port });
  const boundPort = await proxy.start();
  writeProxyState(paths.proxyState, {
    version: 1,
    pid: process.pid,
    port: boundPort,
    domain: settings.domain,
    startedAt: new Date().toISOString(),
  });

  console.log(styleText('green', `factory proxy: listening on 127.0.0.1:${boundPort} (*.${settings.domain})`));
  const leases = readPortLeases(paths.ports);
  if (leases.length === 0) {
    console.log('  no active lane leases yet');
  } else {
    for (const lease of leases) {
      console.log(`  ${laneHostLabel(lease.worktreeId)}.${settings.domain} -> 127.0.0.1:${lease.port}`);
    }
  }
  console.log(
    styleText(
      'dim',
      '  *.localhost resolves to loopback in Chrome/Firefox out of the box (RFC 6761); Safari/curl may need ' +
        'a dnsmasq-backed .test domain instead — documented here, not solved.',
    ),
  );

  await new Promise<void>((resolveShutdown) => {
    const shutdown = () => {
      void proxy
        .stop()
        .catch(() => {})
        .then(() => {
          clearProxyState(paths.proxyState);
          resolveShutdown();
        });
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
  process.exit(0);
}

/** Runs factoryd in the foreground: a loopback-only HTTP server over the repo
 *  registry (~/.factory/registry.json) (#777). Owns the daemon runtime state
 *  next to the registry file — daemon.pid single-instance guard, daemon.port
 *  bound-address record, daemon.log append sink (#1177). `factory daemon
 *  start|stop|status|logs` wrap this process in a launchd LaunchAgent (#1179). */
async function cmdFactoryd(opts: {
  port?: string;
  registry?: string;
  updateMode?: string;
  autoUpdate?: boolean;
}): Promise<void> {
  let config: FactorydConfig;
  try {
    const registryFile = opts.registry ?? defaultRegistryPath();
    const fileConfig = loadDaemonFileConfig(join(dirname(registryFile), 'daemon.json'));
    config = resolveFactorydConfig({ ...opts, registry: registryFile }, { install: detectInstall(), fileConfig });
  } catch (err) {
    if (err instanceof DaemonCtlError) throw new CliExitError(err.message, err.code);
    throw err;
  }
  const { registryFile, port } = config;

  const runtime = daemonRuntimePaths(dirname(registryFile));
  const acquired = await acquirePidFile(runtime);
  if (!acquired.ok) {
    throw new CliExitError(
      `factoryd already running (pid ${acquired.holderPid}) — stop it or remove ${runtime.pidFile}`,
      2,
    );
  }
  const logSink = createDaemonLogSink(runtime.logFile);
  const log = (line: string) => {
    console.log(styleText('dim', line));
    logSink(line);
  };
  if (acquired.stalePid !== null) log(`removed stale pid file (pid ${acquired.stalePid})`);
  for (const notice of config.notices) log(notice);
  const updateFile = updateStatePath(runtime.dir);
  const previousUpdate = readUpdateState(updateFile);
  for (const stop of recoverStaleDrain(previousUpdate, (file) => {
    try {
      unlinkSync(file);
      return true;
    } catch {
      return false;
    }
  })) {
    log(`update: removed stale STOP ${stop}`);
  }
  const updateState = initialUpdateState(config, previousUpdate);
  try {
    writeUpdateState(updateFile, updateState);
  } catch (err) {
    log(`could not write ${updateFile}: ${errorDetail(err)}`);
  }
  log(formatUpdateStartupLine(updateState));

  const runRuntime = await createRunRuntime({
    registryFile,
    allowParallel: true,
    execute: createShipExecutor({ cliEntrypoint: fileURLToPath(new URL('../cli.js', import.meta.url)) }),
  });
  const daemon = createFactorydServer({ registryFile, runsDir: runtime.runsDir, port, log, runRuntime });
  const boundPort = await daemon.start();
  await writePortFile(runtime, boundPort);
  const banner = [
    `factoryd: listening on 127.0.0.1:${boundPort}`,
    `  registry: ${registryFile}`,
    `  update mode: ${config.autoUpdate.mode} (channel ${config.autoUpdate.channel ?? 'none'}, install ${config.install.kind})`,
    `  update state: ${updateFile}`,
    `  pid file: ${runtime.pidFile} (pid ${process.pid})`,
    `  port file: ${runtime.portFile}`,
    `  log file: ${runtime.logFile}`,
    `  GET http://127.0.0.1:${boundPort}/repos`,
    `  POST http://127.0.0.1:${boundPort}/runs  {"runId","repo","issue"}`,
  ];
  console.log(styleText('green', banner[0] ?? ''));
  for (const line of banner.slice(1)) console.log(line);
  for (const line of banner) logSink(line);

  let shuttingDown = false;
  void runAutoUpdateLoop(config, {
    ...createAutoUpdateDeps({
      registryFile,
      stateFile: updateFile,
      cliEntrypoint: fileURLToPath(new URL('../cli.js', import.meta.url)),
      check: () => checkForUpdate(config.autoUpdate.mode === 'prerelease' ? 'prerelease' : 'stable'),
      runRuntime,
      log,
      exit: async (code) => {
        await daemon.stop().catch(() => {});
        await releaseRuntimeFiles(runtime);
        process.exit(code);
      },
    }),
    stopped: () => shuttingDown,
  });
  await new Promise<void>((resolveShutdown) => {
    const shutdown = () => {
      shuttingDown = true;
      void daemon
        .stop()
        .catch(() => {})
        .then(() => releaseRuntimeFiles(runtime))
        .then(() => resolveShutdown());
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
  process.exit(0);
}

function usageFlagOverrides(
  opts: { usageWatch?: boolean; usageThreshold?: string; usagePoll?: string },
  threshold: 'stopAt' | 'resumeAt',
): WatchdogPolicyOverrides {
  return {
    watch: opts.usageWatch,
    [threshold]: opts.usageThreshold === undefined ? undefined : Number(opts.usageThreshold),
    pollSeconds: opts.usagePoll === undefined ? undefined : Number(opts.usagePoll),
  };
}

async function cmdRun(
  opts: {
    localQueue?: boolean;
    autoMerge?: boolean;
    prClassifier?: boolean;
    usageWatch?: boolean;
    usageThreshold?: string;
    usagePoll?: string;
    branchPrefix?: string;
  } = {},
): Promise<void> {
  const repoRoot = await getRepoRoot();
  const paths = getFactoryPaths(repoRoot);
  const branchPrefix = branchPrefixOrExit(opts.branchPrefix);

  return withRepoRunLock(paths, 'factory run', async () => {
    const stopStatus = readStopFileStatus(paths);
    if (stopStatus.present) {
      const msg = stopSentinelRunSkipMessage(stopStatus);
      console.log(styleText('yellow', `!! ${msg}`));
      logEvent(paths.events, 'stopped', 'all', msg);
      return;
    }
    writeRunFlagOverrides(paths.runFlags, { autoMerge: opts.autoMerge, prClassifier: opts.prClassifier });
    const ghRepo = await getGitHubRepo();
    const factoryConfig = configLoaders.loadFactoryConfigForRepo(paths.config);
    const keychainErr = keychainPreflightError(probeClaudeKeychain());
    if (keychainErr) {
      logEvent(paths.events, 'environment_warning', 'all', keychainErr);
      throw new Error(keychainErr);
    }
    await runAutoWorktreeGc(repoRoot, paths, ghRepo, 'all');

    const { lanes, diagnostics } = await planRunLanes({
      localQueue: opts.localQueue === true,
      readLocalQueue: () => (existsSync(paths.queue) ? readFileSync(paths.queue, 'utf-8') : null),
      queue: () => {
        const [owner, repo] = ghRepo.split('/');
        const octokit = getOctokit();
        return createGithubQueue({
          client: createOctokitQueueClient(octokit),
          owner,
          repo,
          preflight: withAdmissionGuard({
            reader: admissionStateReaderFor(paths.state),
            preflight: (issue) =>
              preflightQueuedIssue(
                issue,
                createQueuePreflightOps(octokit, owner, repo, {
                  autoMergeStack:
                    resolveSizeGateMode(factoryConfig) === 'stack' &&
                    resolveMergePolicy(factoryConfig, process.env, { auto: opts.autoMerge }).auto,
                }),
              ),
            onConflict: (issue, verdict) => {
              const line = `#${issue} refused — ${verdict.reason} | repair: ${verdict.repair}`;
              console.error(styleText('yellow', `factory: ${line}`));
              logEvent(paths.events, 'queue_admission_conflict', String(issue), line);
            },
          }),
        });
      },
    });
    warnQueueDiagnostics(diagnostics);

    let knobs: UsageKnobs;
    let laneBreakerThreshold: number;
    try {
      knobs = resolveUsageKnobs(
        process.env,
        configLoaders.loadRepoConfig(repoRoot),
        usageFlagOverrides(opts, 'stopAt'),
      );
      laneBreakerThreshold = resolveLaneBreakerThreshold(configLoaders.loadRepoConfig(repoRoot));
    } catch (err: any) {
      throw new CliExitError(`factory: ${err.message}`, 2);
    }
    if (knobs.watchSource === 'flag') {
      const detail = `usage watchdog ${knobs.watch ? 'enabled' : 'disabled'} by ${usageWatchSourceLabel(knobs.watchSource, knobs.watch)}`;
      console.log(`[factory] run: ${detail}`);
      logEvent(paths.events, 'watchdog', 'all', detail);
    }
    if (knobs.stopAtSource === 'flag') {
      const detail = 'usage watchdog threshold set by flag: --usage-threshold';
      console.log(`[factory] run: ${detail}`);
      logEvent(paths.events, 'watchdog', 'all', detail);
    }
    if (knobs.pollSource === 'flag') {
      const detail = 'usage watchdog poll set by flag: --usage-poll';
      console.log(`[factory] run: ${detail}`);
      logEvent(paths.events, 'watchdog', 'all', detail);
    }
    let watchdogHarness: string | undefined;
    if (knobs.watch) {
      try {
        const repoConfig = configLoaders.loadRepoConfig(repoRoot);
        const registry = new coreOps.ModelRegistry(applyRepoConfig(configLoaders.loadModelsConfig(), repoConfig));
        const pins = configLoaders.resolveEffectiveModelPins(registry, repoConfig, process.env);
        const build = resolveEffectiveBuildRoute(registry, repoConfig, pins);
        watchdogHarness = resolveRunUsageHarness({
          buildRoute: build.route,
          buildRouteSource: build.source,
          planHarnesses: [pins.plan, pins.planFallback]
            .filter((m): m is string => !!m)
            .map((m) => registry.getHarnessId(m)),
          codexDisabled: resolveCodexDisabled(repoConfig),
          localOnly: resolveLocalOnly(),
        });
      } catch {
        watchdogHarness = undefined; // unresolvable config keeps today's Claude gating
      }
    }
    const controller = new AbortController();
    const watchdog = knobs.watch
      ? coreOps
          .watchUsage({
            cap: knobs.cap,
            stopAt: knobs.stopAt,
            pollMs: knobs.pollMs,
            stopFile: paths.stop,
            eventsFile: paths.events,
            signal: controller.signal,
            estimator: knobs.estimator,
            ...(watchdogHarness ? { harness: watchdogHarness } : {}),
          })
          .catch((err: any) => {
            // a watchdog crash must never take down the run
            logEvent(paths.events, 'warn', '-', `usage watchdog crashed: ${err.message}`);
          })
      : Promise.resolve();

    const { proxy } = await startLaneProxy(paths, resolveEnvironmentProxy(factoryConfig));

    const workspaceBackend = factoryConfig.workspace?.backend ?? 'host';
    const runId = randomUUID();
    const containerEngine = workspaceBackend === 'disposable-docker' ? createDockerEngine({}) : undefined;

    try {
      // Run lanes in parallel
      const pids: Promise<void>[] = [];
      for (const planned of lanes) {
        logEvent(
          paths.events,
          'lane-start',
          '-',
          `lane '${planned.lane}' started${planned.issues.length ? ` (${planned.issues.length} issues)` : ''}`,
          { lane: planned.lane },
        );
        if (containerEngine) {
          const provision = await provisionLaneContainer(
            containerEngine,
            workspaceBackend,
            runId,
            slugify(planned.lane),
            ghRepo,
          );
          if (provision.attempted && !provision.created) {
            logEvent(
              paths.events,
              'warn',
              '-',
              `disposable-docker container creation failed for lane '${planned.lane}': ${provision.error}`,
              { lane: planned.lane },
            );
          } else if (provision.attempted && provision.created && provision.workspaceCloned === false) {
            logEvent(
              paths.events,
              'warn',
              '-',
              `disposable-docker workspace clone failed for lane '${planned.lane}': ${provision.workspaceError}`,
              { lane: planned.lane },
            );
          }
        }
        pids.push(
          runLane(planned.lane, planned.issues, repoRoot, ghRepo, paths, {
            ...planned.deps,
            laneBreakerThreshold,
            baseHoldGate:
              opts.localQueue === true
                ? undefined
                : createBaseHoldGate({
                    file: paths.baseHold,
                    repo: ghRepo,
                    onCleared: (c) =>
                      logEvent(paths.events, 'base-hold-cleared', planned.lane, formatBaseHoldCleared(c), {
                        lane: planned.lane,
                      }),
                    git: (cmd) => shellOps.exec(cmd, { cwd: repoRoot }).then((r) => r.stdout),
                    listCheckRuns: (ref) => {
                      const [owner, repoName] = ghRepo.split('/');
                      return createOctokitGreenPrClient(getOctokit()).listCheckRuns({ owner, repo: repoName, ref });
                    },
                  }),
            commentIssue: async (issue, body) => {
              const [owner, repoName] = ghRepo.split('/');
              await getOctokit().rest.issues.createComment({ owner, repo: repoName, issue_number: issue, body });
            },
            ship: (issue, o, c) => shipIssue(issue, { ...o, branchPrefix, prClassifier: opts.prClassifier }, c),
            sweepFinished: (issue) =>
              sweepBetweenLaneIssues(issue, planned.lane, repoRoot, ghRepo, paths).then(() => {}),
            reapWorktree: (issue) =>
              reapParkedLaneWorktree(
                issue,
                repoRoot,
                ghRepo,
                paths,
                opts.branchPrefix === undefined ? undefined : branchPrefix,
              ),
            recordStackMerge: (issue, prNumber) =>
              recordSliceMerged({ octokit: getOctokit(), repo: ghRepo, issue, prNumber }).then(() => {}),
            waitMerge: (issue, branch, root, gh, p, d = {}) =>
              waitForMerge(issue, branch, root, gh, p, { ...d, mergeOverrides: { auto: opts.autoMerge } }),
          }),
        );
      }

      await Promise.allSettled(pids);
      controller.abort();
      await watchdog;
      logEvent(paths.events, 'run-done', 'all', 'all lanes finished');
    } finally {
      if (proxy) {
        await proxy.stop();
        clearProxyState(paths.proxyState);
      }
    }

    if (lanes.length > 0) {
      try {
        const events = existsSync(paths.events) ? readEvents(paths.events) : [];
        const costs = existsSync(paths.costs) ? internalOps.readCosts(paths.costs) : [];
        const recon = await reconstructHumanEventsForKpis(events, branchPrefix);
        const kpis = computeHealthKpis(recon.events, costs);
        await appendKpiSnapshot(paths, repoRoot, kpis, { partial: recon.partial });
        if (recon.partial) {
          logEvent(
            paths.events,
            'warn',
            'all',
            `kpi snapshot partial: GitHub human-event reconstruction failed: ${recon.error}`,
          );
        }
        logEvent(paths.events, 'kpi-snapshot', 'all', `KPI snapshot appended to ${paths.kpiHistory}`);
      } catch (err: any) {
        logEvent(paths.events, 'warn', 'all', `kpi snapshot failed: ${err.message}`);
      }
    }
  });
}

/** Wraps cmdRun so an empty queue is a no-op (not a throw) while auto-ingest is enabled and watching. */
export function createSuperviseRunQueue(
  paths: ReturnType<typeof getFactoryPaths>,
  ingestCfg: IngestSettings,
  deps: {
    cmdRunFn?: () => Promise<void>;
    readQueueFile?: () => string;
    pendingCount?: () => Promise<number>;
    emitEvent?: typeof logEvent;
  } = {},
): () => Promise<void> {
  const {
    cmdRunFn = cmdRun,
    readQueueFile = () => (existsSync(paths.queue) ? readFileSync(paths.queue, 'utf-8') : ''),
    pendingCount = async () => parseQueue(readQueueFile()).entries.length,
    emitEvent = logEvent,
  } = deps;
  return async () => {
    if ((await pendingCount()) === 0 && ingestCfg.enabled) {
      emitEvent(paths.events, 'idle', 'auto', 'queue empty — waiting for ready issues');
      return;
    }
    await cmdRunFn();
  };
}

/** Builds the per-cycle auto-ingest hook passed to superviseLoop; failures are logged, never thrown. */
export function createIngestHook(
  repoRoot: string,
  paths: ReturnType<typeof getFactoryPaths>,
  ingestCfg: IngestSettings,
  deps: { runAutoIngestFn?: typeof runAutoIngest; emitEvent?: typeof logEvent; branchPrefix?: string } = {},
): () => Promise<number> {
  const { runAutoIngestFn = runAutoIngest, emitEvent = logEvent } = deps;
  return async () => {
    try {
      const result = await runAutoIngestFn({
        repoDir: repoRoot,
        queueFile: paths.queue,
        watermarkFile: paths.ingestWatermark,
        label: ingestCfg.label,
        lane: ingestCfg.lane,
        maxPerCycle: ingestCfg.maxPerCycle,
        branchPrefix: deps.branchPrefix ?? resolveBranchPrefix(),
        forceAdmit: process.env.FACTORY_INGEST_FORCE_ADMIT === '1',
      });
      for (const held of result.skippedFileOverlap) {
        emitEvent(
          paths.events,
          'ingest_file_overlap_held',
          held.issue,
          `#${held.issue} held back — names the same file (${held.path}) as already-admitted #${held.collidesWith}; set FACTORY_INGEST_FORCE_ADMIT=1 to admit both`,
        );
      }
      if (result.appended.length) {
        emitEvent(
          paths.events,
          'ingested',
          'auto',
          `auto-ingest appended ${result.appended.length} ready issue(s): ${result.appended.join(', ')}`,
        );
      }
      return result.appended.length;
    } catch (err) {
      emitEvent(paths.events, 'warn', 'auto', `auto-ingest failed: ${errorDetail(err)}`);
      return 0;
    }
  };
}

type RunLaneDeps = {
  /** Lane circuit breaker (#1918): pause after this many consecutive parks with the same
   *  non-empty failure signature. 0 or absent = off; cmdRun wires the resolved
   *  budget.laneBreakerThreshold. */
  laneBreakerThreshold?: number;
  /** Posts the lane-paused comment on the tripping issue (#1919). Defaults to a no-op so
   *  injected-deps callers and tests are unaffected; cmdRun wires it to issues.createComment. */
  commentIssue?: (issue: number, body: string) => Promise<void>;
  ship?: (
    issue: number,
    opts: { product?: string; autoRework?: boolean; interactive?: boolean; approvePlan?: boolean },
    ctx?: {
      repoRoot: string;
      ghRepo: string;
      paths: ReturnType<typeof getFactoryPaths>;
      lane?: string;
      onOutcome?: (outcome: RunOutcome) => void;
    },
  ) => Promise<string>;
  waitMerge?: typeof waitForMerge;
  /** ADR-0161: records a landed stack layer as merged in the slice-plan comment. Defaults to a no-op. */
  recordStackMerge?: (issue: number, prNumber: number) => Promise<void>;
  pathExists?: (path: string) => boolean;
  emitEvent?: typeof logEvent;
  claimNext?: () => Promise<QueueClaim | null>;
  releaseIssue?: (issue: number, outcome: QueueReleaseOutcome) => Promise<void>;
  /** Refreshes the claim lease every HEARTBEAT_INTERVAL_MS while an issue is in flight
   *  (#1500). Absent for static local-queue lanes, which carry no remote claim to lease. */
  heartbeat?: (issue: number) => Promise<unknown>;
  /** Eager park-time worktree reap (#1007). Defaults to a no-op so injected-deps callers and
   *  tests are unaffected; cmdRun wires it to reapParkedLaneWorktree. */
  reapWorktree?: (issue: number) => Promise<void>;
  /** Between-issues worktree GC pass (#1757), run after every terminal outcome before the
   *  lane moves on. Defaults to a no-op so injected-deps callers and tests are unaffected;
   *  cmdRun wires it to sweepBetweenLaneIssues. */
  sweepFinished?: (issue: number) => Promise<void>;
  /** Number of issues still claimable on this lane's remote queue (#1222). Absent for
   *  static local lanes, whose pending list is the whole truth. */
  countRemaining?: () => Promise<number>;
  /** Base-hold claim gate (#2349): consulted before every remote claim; 'hold' stops the lane
   *  without claiming. Absent = always claim (local lanes, injected-deps callers, tests). */
  baseHoldGate?: () => Promise<BaseHoldDecision>;
};

export interface PlannedLane {
  lane: string;
  /** Seed issues to work before claiming. Always empty in GitHub-queue mode. */
  issues: number[];
  deps: Pick<RunLaneDeps, 'claimNext' | 'releaseIssue' | 'heartbeat' | 'countRemaining'>;
}

export function laneQueueDeps(
  queue: GithubQueue,
  lane: string,
): Pick<RunLaneDeps, 'claimNext' | 'releaseIssue' | 'heartbeat' | 'countRemaining'> {
  return {
    claimNext: () => queue.claimNext(lane),
    releaseIssue: (issue, outcome) => queue.release(issue, outcome),
    heartbeat: (issue) => queue.heartbeat(issue),
    countRemaining: async () => (await queue.list(lane)).length,
  };
}

export interface OpenPullRequestEvidence {
  number: number;
  branch: string;
  headSha: string;
  headRepoFullName: string | null;
}

/** A slice PR's state as the queue preflight sees it (ADR-0147). */
export type SlicePullState = 'open' | 'merged' | 'closed';

export interface QueuePreflightOps {
  expectedHeadRepoFullName: string;
  findOpenPR(issue: number): Promise<OpenPullRequestEvidence | undefined>;
  getLandState(prNumber: number): ReturnType<typeof getPullRequestLandState>;
  watch(ref: string): Promise<CiOutcome>;
  /** The factory-written slice plan comment on the issue (ADR-0147). */
  findSlicePlan(issue: number): Promise<SlicePlanCommentLookup>;
  /** State of a slice PR found by the number recorded in the slice plan. */
  getPullState(prNumber: number): Promise<SlicePullState>;
  /** Rewrite the factory's slice plan comment in place. */
  saveSlicePlan(issue: number, plan: SlicePlan): Promise<void>;
  /** ADR-0161: sizeGate.mode is `stack` and the merge policy is auto, so preflight may adopt the lowest open stack layer. */
  autoMergeStack: boolean;
  /** Current head/base refs of a slice PR; the head SHA is the rebased one after GitHub retargets a layer. */
  getPullRefs(prNumber: number): Promise<{ headRef: string; baseRef: string; headSha: string }>;
}

export function createQueuePreflightOps(
  octokit: Octokit,
  owner: string,
  repo: string,
  opts: { autoMergeStack?: boolean } = {},
): QueuePreflightOps {
  return {
    autoMergeStack: opts.autoMergeStack ?? false,
    getPullRefs: async (prNumber) => {
      const { data } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
      return { headRef: data.head.ref, baseRef: data.base.ref, headSha: data.head.sha };
    },
    expectedHeadRepoFullName: `${owner}/${repo}`,
    findOpenPR: (issue) => findOpenPRForIssue(octokit, owner, repo, issue),
    getLandState: (prNumber) => getPullRequestLandState(octokit, owner, repo, prNumber),
    watch: (ref) => internalOps.watchChecks({ octokit, owner, repo, ref }),
    findSlicePlan: (issue) => findSlicePlanComment({ octokit, repo: `${owner}/${repo}`, issue }),
    getPullState: async (prNumber) => {
      const { data } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
      if (data.merged || data.merged_at) return 'merged';
      return data.state === 'open' ? 'open' : 'closed';
    },
    saveSlicePlan: async (issue, plan) => {
      await upsertSlicePlanComment({ octokit, repo: `${owner}/${repo}`, issue, plan });
    },
  };
}

/** ADR-0147/ADR-0161: walk every pr-open slice PR bottom-up. Merged layers are recorded, a closed layer parks
 *  (naming the layers above it), and the lowest open layer defers, or is adopted when stack auto-merge is on and
 *  its base is main with green CI on the rebased head. Returns undefined to fall through to the Closes-PR
 *  preflight only when no slice PR is still open. */
async function preflightSlice(issue: number, deps: QueuePreflightOps): Promise<QueuePreflightDecision | undefined> {
  let lookup: SlicePlanCommentLookup;
  try {
    lookup = await deps.findSlicePlan(issue);
  } catch (err) {
    return { kind: 'park', reason: `slice plan lookup failed: ${errorDetail(err)}` };
  }
  if (lookup.status === 'invalid') {
    return {
      kind: 'park',
      reason: `slice plan comment ${lookup.commentId} on #${issue} is unreadable (${lookup.error})`,
    };
  }
  if (lookup.status === 'not-found') return undefined;
  const { plan } = lookup;
  const n = plan.slices.length;
  const open = plan.slices.filter((s) => s.state === 'pr-open');
  if (open.length === 0) return undefined;
  let next = plan;
  let lastMerged: { label: string; pr: number } | undefined;
  const save = async (): Promise<QueuePreflightDecision | undefined> => {
    if (lastMerged === undefined) return undefined;
    try {
      await deps.saveSlicePlan(issue, next);
    } catch (err) {
      return {
        kind: 'park',
        reason: `${lastMerged.label} PR #${lastMerged.pr} merged but updating the slice plan failed: ${errorDetail(err)}`,
      };
    }
    return undefined;
  };
  for (const [at, slice] of open.entries()) {
    const label = `slice ${slice.index}/${n}`;
    if (slice.prNumber === undefined) {
      return { kind: 'park', reason: `${label} of #${issue} is pr-open but the slice plan records no PR number` };
    }
    const pr = slice.prNumber;
    let state: SlicePullState;
    try {
      state = await deps.getPullState(pr);
    } catch (err) {
      return { kind: 'park', reason: `${label} PR #${pr} state lookup failed: ${errorDetail(err)}` };
    }
    if (state === 'merged') {
      next = withSliceState(next, slice.index, 'merged', pr);
      lastMerged = { label, pr };
      continue;
    }
    if (state === 'closed') {
      const above = open.slice(at + 1);
      const suffix =
        above.length > 0
          ? `; layers above it: ${above.map((a) => `slice ${a.index}/${n} (#${a.prNumber})`).join(', ')}`
          : '';
      return { kind: 'park', reason: `${label} PR #${pr} was closed without merging${suffix}` };
    }
    const saved = await save();
    if (saved) return saved;
    if (!deps.autoMergeStack) return { kind: 'defer' };
    let refs: Awaited<ReturnType<QueuePreflightOps['getPullRefs']>>;
    try {
      refs = await deps.getPullRefs(pr);
    } catch (err) {
      return { kind: 'park', reason: `${label} PR #${pr} ref lookup failed: ${errorDetail(err)}` };
    }
    // GitHub has not retargeted the layer to main yet: the lower layer is still unmerged.
    if (refs.baseRef !== 'main') return { kind: 'defer' };
    let outcome: CiOutcome;
    try {
      outcome = await deps.watch(refs.headSha);
    } catch (err) {
      return { kind: 'park', reason: `CI watch for ${label} PR #${pr} failed: ${errorDetail(err)}` };
    }
    if (outcome === 'failure') return { kind: 'park', reason: `CI for ${label} PR #${pr} ended failure` };
    if (outcome !== 'success') return { kind: 'defer' };
    return { kind: 'adopt', branch: refs.headRef, stackLayer: { index: slice.index, count: n, prNumber: pr } };
  }
  return (await save()) ?? undefined;
}

/** Resolve queued work from GitHub evidence without consuming model or worktree resources. */
export async function preflightQueuedIssue(
  issue: QueueIssue,
  deps: QueuePreflightOps,
): Promise<QueuePreflightDecision> {
  if (issue.labels.includes('factory:in-progress')) return { kind: 'defer' };

  const slice = await preflightSlice(issue.number, deps);
  if (slice) return slice;

  let pr: OpenPullRequestEvidence | undefined;
  try {
    pr = await deps.findOpenPR(issue.number);
  } catch (err) {
    return { kind: 'park', reason: `PR lookup failed: ${errorDetail(err)}` };
  }
  if (!pr) return { kind: 'build' };
  if (pr.headRepoFullName !== deps.expectedHeadRepoFullName) {
    return { kind: 'park', reason: `PR #${pr.number} head is not in ${deps.expectedHeadRepoFullName}` };
  }

  let state: Awaited<ReturnType<typeof getPullRequestLandState>>;
  try {
    state = await deps.getLandState(pr.number);
  } catch (err) {
    return { kind: 'park', reason: `PR #${pr.number} merge-state lookup failed: ${errorDetail(err)}` };
  }
  if (state.isDraft !== false) {
    return { kind: 'park', reason: `PR #${pr.number} is draft or its draft state is unavailable` };
  }
  if (!state.mergeStateStatus || state.mergeStateStatus === 'UNKNOWN') {
    return { kind: 'park', reason: `PR #${pr.number} merge state is unavailable` };
  }

  let outcome: CiOutcome;
  try {
    outcome = await deps.watch(pr.headSha);
  } catch (err) {
    return { kind: 'park', reason: `CI watch for PR #${pr.number} failed: ${errorDetail(err)}` };
  }
  if (outcome !== 'success') return { kind: 'park', reason: `CI for PR #${pr.number} ended ${outcome}` };
  return { kind: 'adopt', branch: pr.branch };
}

export async function planRunLanes(input: {
  localQueue: boolean;
  /** `null` when `.factory/queue` does not exist. */
  readLocalQueue: () => string | null;
  /** Lazy so the octokit client is never built under --local-queue. */
  queue: () => GithubQueue;
}): Promise<{ lanes: PlannedLane[]; diagnostics: QueueDiagnostic[] }> {
  if (input.localQueue) {
    const content = input.readLocalQueue();
    if (content === null) {
      throw new CliExitError('queue empty — run factory init + triage first', 2);
    }
    const { entries, diagnostics } = parseQueue(content);
    const byLane = new Map<string, number[]>();
    for (const e of entries) {
      if (!byLane.has(e.lane)) byLane.set(e.lane, []);
      byLane.get(e.lane)!.push(e.issue);
    }
    return {
      lanes: [...byLane].map(([lane, issues]) => ({ lane, issues, deps: {} })),
      diagnostics,
    };
  }

  const gq = input.queue();
  const lanes = await gq.lanes();
  return {
    lanes: lanes.map((lane) => ({ lane, issues: [], deps: laneQueueDeps(gq, lane) })),
    diagnostics: [],
  };
}

/** How often an in-flight issue's claim lease is refreshed (#1500). Well inside the
 *  15-minute default lease (github-queue.ts's DEFAULT_CLAIM_LEASE_MS) so a normal poll
 *  cadence never lets the lease lapse mid-ship. */
const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;

/** Runs `work` while periodically calling `heartbeat(issue)` so a long-running ship or
 *  merge wait keeps this claimant's lease fresh. A heartbeat failure is swallowed — losing
 *  one refresh must never abort the work it is protecting. */
async function withHeartbeat<T>(
  issue: number,
  heartbeat: ((issue: number) => Promise<unknown>) | undefined,
  work: () => Promise<T>,
): Promise<T> {
  if (!heartbeat) return work();
  const timer = setInterval(() => {
    heartbeat(issue).catch(() => {});
  }, HEARTBEAT_INTERVAL_MS);
  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}

export function renderLanePausedComment(payload: LanePausedPayload): string {
  const checks = payload.failingChecks.length
    ? payload.failingChecks.map((c) => `\`${c}\``).join(', ')
    : 'none recorded';
  return [
    `Lane '${payload.lane}' is paused: this issue and #${payload.firstIssue} parked with the same failure signature, so the factory stopped claiming issues on this lane.`,
    `Shared failing checks: ${checks}`,
    `To resume: fix the shared failure (often on the base branch), then re-run \`factory run\` to resume lane '${payload.lane}'.`,
    `Failure signature: \`${payload.signature}\``,
  ].join('\n\n');
}

export async function runLane(
  lane: string,
  issues: number[],
  repoRoot: string,
  ghRepo: string,
  paths: ReturnType<typeof getFactoryPaths>,
  deps: RunLaneDeps = {},
) {
  const {
    ship = shipIssue,
    waitMerge = waitForMerge,
    recordStackMerge = async () => {},
    pathExists = existsSync,
    emitEvent = logEvent,
    claimNext = async () => null,
    releaseIssue = async () => {},
    heartbeat,
    reapWorktree = async () => {},
    sweepFinished = async () => {},
    countRemaining,
    baseHoldGate,
    laneBreakerThreshold = 0,
    commentIssue = async () => {},
  } = deps;
  let streak: { signature: string; firstIssue: number; failingChecks: string[]; count: number } | null = null;
  let merged = 0;
  let awaitingReview = 0;
  let skipped = 0;
  let decomposed = 0;
  let parked = 0;
  const buildClaim = (issue: number): QueueClaim => ({ issue, decision: { kind: 'build' } });
  const pending: QueueClaim[] = issues.map(buildClaim);
  const seen = new Set(issues);
  // Truthful park-time remaining count (#1222): local pending plus the lane's still-queued
  // remote issues. Fail-closed — a count lookup may never change the message beyond the
  // local truth, and never lane flow.
  const remainingAfter = async (index: number): Promise<number> => {
    const local = pending.length - index - 1;
    if (!countRemaining) return local;
    try {
      return local + (await countRemaining());
    } catch {
      return local;
    }
  };
  // Every terminal outcome releases the claim, then gives finished worktrees a GC pass before
  // the lane moves on (#1757). The pass is fail-closed and must never change lane flow.
  const settle = async (issue: number, outcome: QueueReleaseOutcome): Promise<void> => {
    await releaseIssue(issue, outcome);
    await sweepFinished(issue).catch(() => {});
  };
  for (let i = 0; ; i++) {
    if (i >= pending.length) {
      // A persisted base hold on the unchanged origin/main SHA means the base is still broken
      // (#2349): claiming would just cycle an issue again, so stop this lane without claiming.
      const gate = baseHoldGate ? await baseHoldGate().catch((): BaseHoldDecision => ({ kind: 'claim' })) : null;
      if (gate?.kind === 'hold') {
        emitEvent(
          paths.events,
          'warn',
          lane,
          `lane '${lane}' not claiming: base hold on ${gate.hold.baseSha.slice(0, 8)} (${gate.hold.failingChecks.join(', ')}) — origin/main unchanged and its CI is not green`,
          { lane },
        );
        return;
      }
      const claimed = await claimNext();
      if (claimed === null) break;
      seen.add(claimed.issue);
      pending.push(claimed);
    }
    const { issue, decision } = pending[i];
    if (pathExists(paths.stop)) {
      emitEvent(paths.events, 'stopped', issue, 'STOP file present', { lane });
      await releaseIssue(issue, 'queued');
      return;
    }
    if (decision.kind === 'park') {
      emitEvent(paths.events, 'escalate', issue, decision.reason, { lane });
      emitEvent(
        paths.events,
        'parked',
        issue,
        `issue #${issue} parked (${decision.reason}); lane '${lane}' continuing, ${await remainingAfter(i)} issue(s) remaining`,
        { lane },
      );
      // A preflight-parked issue may still have a stale worktree from a prior run; the reap
      // is fail-closed and must never change lane flow.
      await reapWorktree(issue).catch(() => {});
      await settle(issue, 'parked');
      parked++;
      streak = null;
      continue;
    }
    const layer = decision.kind === 'adopt' ? decision.stackLayer : undefined;
    try {
      const sliceOutcome: { value?: RunOutcome } = {};
      const branch =
        decision.kind === 'adopt'
          ? decision.branch
          : await withHeartbeat(issue, heartbeat, () =>
              ship(
                issue,
                {},
                {
                  repoRoot,
                  ghRepo,
                  paths,
                  lane,
                  onOutcome: (o) => {
                    sliceOutcome.value = o;
                  },
                },
              ),
            );
      const shipped = sliceOutcome.value;
      if (shipped?.state === 'ready' && shipped.slice && shipped.slice.index < shipped.slice.count) {
        // ADR-0147: a non-final slice's PR is open; hand the issue back for the next slice
        // instead of waiting for the merge.
        awaitingReview++;
        streak = null;
        await settle(issue, 'queued');
        continue;
      }
      if (layer) {
        // ADR-0161: land exactly this layer's branch, record it, and re-queue for the next layer.
        await withHeartbeat(issue, heartbeat, () =>
          waitMerge(issue, branch, repoRoot, ghRepo, paths, { landBranch: branch }),
        );
        await recordStackMerge(issue, layer.prNumber).catch((err) =>
          emitEvent(
            paths.events,
            'warn',
            issue,
            `slice ${layer.index}/${layer.count} merged but recording it failed: ${errorDetail(err)}`,
            { lane },
          ),
        );
        merged++;
        streak = null;
        await settle(issue, layer.index < layer.count ? 'queued' : 'done');
        continue;
      }
      await withHeartbeat(issue, heartbeat, () => waitMerge(issue, branch, repoRoot, ghRepo, paths));
      merged++;
      streak = null;
      await settle(issue, 'done');
    } catch (err: any) {
      if (err instanceof AwaitingReviewError) {
        // The land path already emitted the awaiting-review event and cleaned the
        // worktree — this is a clean outcome, not a park; move to the next issue.
        awaitingReview++;
        streak = null;
        await settle(issue, layer && layer.index < layer.count ? 'queued' : 'done');
        continue;
      }
      if (err instanceof IssueSkippedError) {
        // shipIssue already emitted skipped-already-closed; nothing was attempted.
        skipped++;
        await settle(issue, 'done');
        continue;
      }
      if (err instanceof IssueDecomposedError) {
        // shipIssue already rewrote the queue — splice the children in after the
        // current issue so this same lane run ships them, deduping ones already queued.
        const fresh = err.childIssues.filter((n) => !seen.has(n));
        for (const n of fresh) seen.add(n);
        pending.splice(i + 1, 0, ...fresh.map(buildClaim));
        decomposed++;
        emitEvent(
          paths.events,
          'decompose_filed',
          issue,
          `lane '${lane}' continuing with ${fresh.length} child issue(s) in place of #${issue}`,
          { lane },
        );
        await settle(issue, 'done');
        continue;
      }
      if (err instanceof LaneEnvironmentPauseError) {
        // The base is broken, not the issue (#1928): release to queued (never parked),
        // pause the lane whatever laneBreakerThreshold is, and stop claiming.
        streak = null;
        // A preserved build is kept for `factory resume --from check` (#2564).
        if (!err.buildPreserved) await reapWorktree(issue).catch(() => {});
        await settle(issue, 'queued');
        // Persist the hold so a restarted supervisor remembers the broken base (#2348);
        // best-effort, never allowed to change lane flow.
        try {
          writeBaseHold(paths.baseHold, {
            repo: ghRepo,
            baseSha: err.baseSha,
            failingChecks: err.failingChecks,
            since: new Date().toISOString(),
          });
        } catch {}
        const payload: LanePausedPayload = {
          lane,
          signature: err.failureSignature ?? '',
          failingChecks: err.failingChecks,
          firstIssue: issue,
          secondIssue: issue,
          cause: 'environment',
          baseSha: err.baseSha,
        };
        emitEvent(
          paths.events,
          'lane-paused',
          lane,
          `lane '${lane}' paused: #${issue} failed only on checkers that also fail on base ${err.baseSha.slice(0, 8)} (${err.failingChecks.join(', ')}); #${issue} released to queued`,
          { lane, lanePaused: payload },
        );
        return;
      }
      const reason = parkReasonFor(err);
      // Terminal reason events (escalate/timeout/fail/conflict) are emitted exactly
      // once by the layer that detects the failure — shipIssue for pipeline failures,
      // the land path for merge failures. runLane owns only lane-lifecycle events
      // (stopped/parked/lane-done), so injected ship functions never change ownership.
      const signature = err instanceof LaneParkError ? err.failureSignature : undefined;
      const checks = err instanceof LaneParkError ? (err.failingChecks ?? []) : [];
      if (!signature) streak = null;
      else if (streak && streak.signature === signature) streak.count++;
      else streak = { signature, firstIssue: issue, failingChecks: checks, count: 1 };
      const tripped = laneBreakerThreshold > 0 && streak !== null && streak.count >= laneBreakerThreshold;
      emitEvent(
        paths.events,
        'parked',
        issue,
        `issue #${issue} parked (${reason}); ${
          tripped ? `lane '${lane}' paused (lane breaker)` : `lane '${lane}' continuing`
        }, ${await remainingAfter(i)} issue(s) remaining`,
        { lane },
      );
      // Remove the parked lane's own worktree so a parked issue stops leaving a sibling
      // checkout behind (#1007); fail-closed and never allowed to change lane flow.
      await reapWorktree(issue).catch(() => {});
      await settle(issue, 'parked');
      parked++;
      if (tripped && streak) {
        const { signature: tripSignature, firstIssue, failingChecks: firstChecks } = streak;
        const payload: LanePausedPayload = {
          lane,
          signature: tripSignature,
          failingChecks: checks.filter((c) => firstChecks.includes(c)),
          firstIssue,
          secondIssue: issue,
        };
        emitEvent(
          paths.events,
          'lane-paused',
          lane,
          `lane '${lane}' paused: #${payload.firstIssue} and #${payload.secondIssue} parked with the same failure signature (${payload.failingChecks.join(', ') || 'no failing checks'})`,
          { lane, lanePaused: payload },
        );
        // Tell the developer on GitHub why the lane stopped (#1919); fail-closed, never changes lane flow.
        await commentIssue(payload.secondIssue, renderLanePausedComment(payload)).catch(() => {});
        return;
      }
      continue;
    }
  }
  emitEvent(
    paths.events,
    'lane-done',
    lane,
    `lane complete (${merged} merged, ${awaitingReview} awaiting review, ${skipped} skipped, ${decomposed} decomposed, ${parked} parked)`,
    { lane },
  );
}

/** The target issue was already resolved before the run started — a clean skip,
 *  not a park. Callers advance to the next queue entry. (#681) */
export class IssueSkippedError extends Error {
  constructor(
    message: string,
    readonly reason: 'already-closed',
  ) {
    super(message);
  }
}

/** The target issue tripped the PLAN pre-flight size gate and was decomposed into real
 *  filed sub-issues; the queue was rewritten. Not a park — the lane continues with the
 *  children in place of the oversized issue. (#823) */
export class IssueDecomposedError extends Error {
  constructor(
    message: string,
    readonly childIssues: number[],
  ) {
    super(message);
  }
}
export function issueFromFactoryBranch(branch: string, prefix?: string): number | undefined {
  return factoryBranchIssue(branch, prefix) ?? undefined;
}

export async function listOpenFactoryPRs(
  octokit: Octokit,
  owner: string,
  repoName: string,
  branchPrefix?: string,
): Promise<Array<{ number: number; branch: string; reviewDecision?: string; isDraft?: boolean }>> {
  const prs: Array<{ number: number; branch: string; reviewDecision?: string; isDraft?: boolean }> = [];
  let cursor: string | undefined;

  for (;;) {
    const result = await octokit.graphql<{
      repository?: {
        pullRequests?: {
          pageInfo?: { hasNextPage?: boolean; endCursor?: string };
          nodes?: Array<{ number: number; headRefName: string; reviewDecision?: string; isDraft?: boolean }>;
        };
      };
    }>(
      `query OpenFactoryPRs($owner: String!, $repo: String!, $cursor: String) {
        repository(owner: $owner, name: $repo) {
          pullRequests(states: OPEN, first: 100, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            nodes { number headRefName reviewDecision isDraft }
          }
        }
      }`,
      { owner, repo: repoName, cursor },
    );

    const pullRequests = result.repository?.pullRequests;
    for (const node of pullRequests?.nodes ?? []) {
      if (factoryBranchPrefixes(branchPrefix).some((p) => node.headRefName.startsWith(`${p}/`))) {
        prs.push({
          number: node.number,
          branch: node.headRefName,
          reviewDecision: node.reviewDecision,
          isDraft: node.isDraft,
        });
      }
    }

    if (!pullRequests?.pageInfo?.hasNextPage) break;
    cursor = pullRequests.pageInfo.endCursor;
  }

  return prs;
}

export interface SweepDeps {
  createOctokit?: () => Octokit;
  loadConfig?: (configPath: string) => FactoryConfig;
  listPRs?: typeof listOpenFactoryPRs;
  land?: typeof landIssue;
  emitEvent?: typeof logEvent;
  writeLine?: (line: string) => void;
}

export async function sweepApprovedPRs(
  repoRoot: string,
  ghRepo: string,
  paths: ReturnType<typeof getFactoryPaths>,
  deps: SweepDeps = {},
  opts: { branchPrefix?: string } = {},
): Promise<{
  landed: number[];
  skipped: Array<{ pr: number; branch: string; reason: string }>;
  failed: Array<{ pr: number; issue: number; reason: string }>;
}> {
  const {
    createOctokit = getOctokit,
    loadConfig = configLoaders.loadFactoryConfigForRepo,
    listPRs = listOpenFactoryPRs,
    land = landIssue,
    emitEvent = logEvent,
    writeLine = (line: string) => console.log(line),
  } = deps;

  const [owner, repoName] = ghRepo.split('/');
  const octokit = createOctokit();
  const skipCI = configLoaders.resolveSkipCI(loadConfig(paths.config));
  const prs = await listPRs(octokit, owner, repoName, opts.branchPrefix);

  const landed: number[] = [];
  const skipped: Array<{ pr: number; branch: string; reason: string }> = [];
  const failed: Array<{ pr: number; issue: number; reason: string }> = [];

  for (const pr of prs) {
    const issue = issueFromFactoryBranch(pr.branch, opts.branchPrefix);
    if (issue === undefined) {
      const reason = 'no issue number in branch';
      skipped.push({ pr: pr.number, branch: pr.branch, reason });
      writeLine(`[factory] PR #${pr.number} (${pr.branch}) skipped: ${reason}`);
      continue;
    }

    if (pr.reviewDecision !== 'APPROVED') {
      const reason = `not approved (reviewDecision: ${pr.reviewDecision ?? 'none'})`;
      skipped.push({ pr: pr.number, branch: pr.branch, reason });
      writeLine(`[factory] PR #${pr.number} (${pr.branch}) skipped: ${reason}`);
      continue;
    }

    try {
      await land(issue, repoRoot, ghRepo, paths, octokit, skipCI, opts.branchPrefix);
      landed.push(pr.number);
      writeLine(`[factory] PR #${pr.number} (${pr.branch}) landed for issue #${issue}`);
    } catch (err) {
      const reason = errorDetail(err);
      failed.push({ pr: pr.number, issue, reason });
      writeLine(`[factory] PR #${pr.number} (${pr.branch}) failed to land: ${reason}`);
      continue;
    }
  }

  emitEvent(
    paths.events,
    'resume-approved',
    '-',
    `sweep: ${landed.length} landed, ${skipped.length} skipped, ${failed.length} failed of ${prs.length} open factory PRs`,
  );

  return { landed, skipped, failed };
}

export async function cmdResumeApproved(opts: { branchPrefix?: string } = {}) {
  const branchPrefix = branchPrefixOrExit(opts.branchPrefix);
  const repoRoot = await getRepoRoot();
  const ghRepo = await getGitHubRepo();
  const paths = getFactoryPaths(repoRoot);
  const result = await sweepApprovedPRs(repoRoot, ghRepo, paths, {}, { branchPrefix });
  console.log(
    styleText(
      'green',
      `✅ resume-approved: ${result.landed.length} landed, ${result.skipped.length} skipped, ${result.failed.length} failed`,
    ),
  );
  if (result.failed.length > 0) {
    throw new CliExitError(`factory: resume-approved: ${result.failed.length} PR(s) failed to land`, 5);
  }
}

export interface SuperviseDeps {
  cap: number;
  resumeAt: number;
  pollMs: number;
  watch?: boolean;
  /** Where `watch` was decided, so the loop can attribute an explicit operator override
   *  to the flag rather than always blaming FACTORY_USAGE_WATCH (#1404). */
  watchSource?: WatchdogPolicySource;
  /** Where the resume threshold was decided, for attribution of explicit CLI overrides. */
  resumeAtSource?: WatchdogPolicySource;
  /** Where the poll interval was decided, for attribution of explicit CLI overrides. */
  pollSource?: WatchdogPolicySource;
  estimator?: boolean;
  stopFile: string;
  eventsFile: string;
  now?: boolean;
  runQueue: () => Promise<void>;
  readUsageFn?: () => Promise<UsageReading | null>;
  pathExists?: (path: string) => boolean;
  clearStop?: (path: string) => void;
  sleep?: (ms: number) => Promise<void>;
  emitEvent?: typeof logEvent;
  writeLine?: (line: string) => void;
  /** When set, run once per cycle before draining the queue; returns count appended. Its presence
   *  also switches the loop into perpetual-poll mode (see superviseLoop). */
  ingest?: () => Promise<number>;
}

const USAGE_UNAVAILABLE_LINE =
  '[factory] supervise: usage signal unavailable — proceeding without resume gate (set FACTORY_USAGE_ESTIMATOR=1 to gate on the heuristic)';

export async function superviseLoop(deps: SuperviseDeps): Promise<void> {
  const {
    cap,
    resumeAt,
    pollMs,
    watch = true,
    watchSource = 'default',
    resumeAtSource = 'default',
    pollSource = 'default',
    estimator = false,
    stopFile,
    eventsFile,
    now,
    runQueue,
    readUsageFn = () => readUsage({ cap, estimator }),
    pathExists = existsSync,
    clearStop = (path: string) => rmSync(path, { force: true }),
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    emitEvent = logEvent,
    writeLine = (line: string) => console.log(line),
    ingest,
  } = deps;

  let cycle = 0;
  if (resumeAtSource === 'flag') {
    const detail = 'usage watchdog threshold set by flag: --usage-threshold';
    writeLine(`[factory] supervise: ${detail}`);
    emitEvent(eventsFile, 'watchdog', 'usage', detail);
  }
  if (pollSource === 'flag') {
    const detail = 'usage watchdog poll set by flag: --usage-poll';
    writeLine(`[factory] supervise: ${detail}`);
    emitEvent(eventsFile, 'watchdog', 'usage', detail);
  }
  while (true) {
    cycle++;
    let pct = 0;
    let source = 'unavailable';

    if (!watch) {
      writeLine(
        `[factory] supervise: usage watchdog disabled (${usageWatchSourceLabel(watchSource, watch)}) — skipping resume gate`,
      );
    } else {
      if (watchSource === 'flag') {
        writeLine(
          `[factory] supervise: usage watchdog enabled (${usageWatchSourceLabel(watchSource, watch)}) — enforcing resume gate`,
        );
      }
      let reading = await readUsageFn();
      if (reading === null) {
        writeLine(USAGE_UNAVAILABLE_LINE);
      } else {
        pct = reading.pct;
        source = reading.source;
        if (cycle > 1 || !now) {
          while (pct >= resumeAt) {
            writeLine(
              `[factory] supervise: trailing usage (${source}) ${Math.round(pct * 100)}% >= resume gate ${Math.round(resumeAt * 100)}% — waiting ${pollMs / 1000}s`,
            );
            await sleep(pollMs);
            reading = await readUsageFn();
            if (reading === null) {
              writeLine(USAGE_UNAVAILABLE_LINE);
              pct = 0;
              source = 'unavailable';
              break;
            }
            pct = reading.pct;
            source = reading.source;
          }
        }
      }
    }

    emitEvent(
      eventsFile,
      'resumed',
      'usage',
      `supervise cycle ${cycle}: trailing usage (${source}) at ${Math.round(pct * 100)}% of cap — starting run`,
    );
    clearStop(stopFile);
    if (ingest) {
      const appended = await ingest();
      if (appended > 0) writeLine(`[factory] supervise: auto-ingest appended ${appended} ready issue(s)`);
    }
    await runQueue();
    if (pathExists(stopFile)) continue;
    if (ingest) {
      await sleep(pollMs);
      continue;
    }
    break;
  }
  emitEvent(eventsFile, 'supervisor-done', 'usage', 'supervise finished — queue drained or lanes need attention');
}

export function getCliVersion(): string {
  return createRequire(import.meta.url)('../../package.json').version;
}

function toLeaseRow(health: LeaseHealth): LeaseHealthRow {
  return {
    worktreeId: health.lease.worktreeId,
    branch: health.lease.branch,
    port: health.lease.port,
    pid: health.lease.pid,
    alive: health.alive,
    reason: health.reason,
    portSquatted: health.portSquatted,
  };
}

function toGreenPrRow(pr: UnmergedGreenPr): UnmergedGreenPrRow {
  return { number: pr.number, branch: pr.branch, issue: pr.issue, ageHours: pr.ageHours };
}

async function scanGreenPrs(ghRepo: string | undefined, octokit: Octokit | undefined): Promise<GreenPrScanResult> {
  if (!ghRepo || !octokit) return { status: 'skipped', detail: 'skipped — no GitHub repo or token' };
  const [owner, repoName] = ghRepo.split('/');
  try {
    const prs = await internalOps.findUnmergedGreenPrs({
      client: createOctokitGreenPrClient(octokit),
      owner,
      repo: repoName,
    });
    return { status: 'ok', rows: prs.map(toGreenPrRow) };
  } catch (err: any) {
    return { status: 'failed', detail: err?.message ?? String(err) };
  }
}

function probeClaudeKeychain(): KeychainProbeStatus {
  if (process.platform !== 'darwin') return { status: 'skipped', detail: 'skipped — not macOS' };
  if (!coreOps.isCommandAvailable('claude')) return { status: 'skipped', detail: 'skipped — claude CLI not on PATH' };
  if (process.env.ANTHROPIC_API_KEY) return { status: 'skipped', detail: 'skipped — ANTHROPIC_API_KEY auth in use' };
  // Check the entry for the profile child `claude` runs will use (CLAUDE_CONFIG_DIR), not
  // always the default one.
  const service = claudeKeychainService();
  const profile = { service, configDir: claudeConfigDirOverride() };
  try {
    shellOps.execSync(`security find-generic-password -s ${shellEscape(service)}`, {
      timeout: 10_000,
      stdio: 'ignore',
    });
    return { status: 'readable', ...profile };
  } catch {
    return { status: 'unreadable', inTmux: !!process.env.TMUX, ...profile };
  }
}

/** Injectable seams for main(). Unset fields fall back to the real implementations. */
export interface CliDeps {
  /** Shell seams for every `exec` / `execSync` the CLI runs (git, gh, claude, ollama, security). Default to node:child_process. */
  exec?: ShellExec;
  execSync?: ShellExecSync;
  /** Passed to the `factory daemon start|stop|status|logs` wrappers. */
  daemon?: DaemonCtlDeps;
  /** Passed to `factory self-update --check` (registry fetch, install detection, stdout). */
  selfUpdate?: SelfUpdateDeps;
  /** Replaces the TUI entry point used by `factory tui`. */
  runTui?: typeof runTui;
  /** Builds the GitHub client for every CLI GitHub call (shipIssue, land, queue, triage, …). Defaults to createFactoryOctokit with the resolved token. */
  octokit?: () => Octokit;
  /** Phase overrides forwarded into RunPorts by shipIssue, including calls made from main(). Each defaults to the factory-core phase. */
  planPhase?: RunPorts['planPhase'];
  buildPhase?: RunPorts['buildPhase'];
  checkPhase?: RunPorts['checkPhase'];
  shipPhase?: RunPorts['shipPhase'];
  /** Pre-PLAN base health check (#2339) forwarded into RunPorts by shipIssue. Defaults to the factory-core checkBaseHealth. */
  checkBaseHealth?: RunPorts['checkBaseHealth'];
  /** Config loaders and resolvers. Each defaults to the factory-core export of the same name. */
  loadModelsConfig?: typeof loadModelsConfig;
  loadRoutesConfig?: typeof loadRoutesConfig;
  loadFactoryConfigForRepo?: typeof loadFactoryConfigForRepo;
  loadRepoConfig?: typeof loadRepoConfig;
  resolveTimeouts?: typeof resolveTimeouts;
  resolveSkipCI?: typeof resolveSkipCI;
  getConstitutionsDir?: typeof getConstitutionsDir;
  resolveEffectiveModelPins?: typeof resolveEffectiveModelPins;
  /** Git worktree/fetch side effects. Each defaults to the factory-core export of the same name. */
  setupWorktree?: typeof setupWorktree;
  cleanupWorktree?: typeof cleanupWorktree;
  gitFetch?: typeof gitFetch;
  /** factory-core/internal ops (CI watch, costs, worktree GC, reconcile reaps, local-small). Each defaults to the export of the same name. */
  watchChecks?: typeof watchChecks;
  createLocalSmallDryRun?: typeof createLocalSmallDryRun;
  readCosts?: typeof readCosts;
  sweepWorktrees?: typeof sweepWorktrees;
  releaseStaleClaims?: typeof releaseStaleClaims;
  findUnmergedGreenPrs?: typeof findUnmergedGreenPrs;
  listOrphanContainers?: typeof listOrphanContainers;
  reapOrphanContainers?: typeof reapOrphanContainers;
  listMicroVms?: typeof listMicroVms;
  reapOrphanMicroVm?: typeof reapOrphanMicroVm;
  formatGcReport?: typeof formatGcReport;
  /** factory-core classes and ops (routing, constitutions, process/port probes, usage, diagnose, local report). Each defaults to the export of the same name. */
  ModelRouter?: typeof ModelRouter;
  ConstitutionLoader?: typeof ConstitutionLoader;
  ModelRegistry?: typeof ModelRegistry;
  isCommandAvailable?: typeof isCommandAvailable;
  defaultFindPortListeners?: typeof defaultFindPortListeners;
  reapOrphanProcesses?: typeof reapOrphanProcesses;
  estimateTrailingSpend?: typeof estimateTrailingSpend;
  formatUsageReport?: typeof formatUsageReport;
  watchUsage?: typeof watchUsage;
  fetchSubscriptionUsage?: typeof fetchSubscriptionUsage;
  diagnoseModels?: typeof diagnoseModels;
  probeDeclaredHarnesses?: typeof probeDeclaredHarnesses;
  writeLocalRunReport?: typeof writeLocalRunReport;
}

/** Appends one event to the events log without echoing it to stdout (stop/resume --json must print only JSON). */
function logEventQuietly(eventsFile: string, type: EventKind, msg: string): void {
  createLogger(eventsFile, { issue: '-' }, { out: { write: () => true } }).warn(type, msg);
}

/** Creates the STOP file in one exclusive open (no check-then-write race). Returns false when it already existed. */
function createStopFile(stopFile: string): boolean {
  try {
    writeFileSync(stopFile, '', { flag: 'wx' });
    return true;
  } catch (err: any) {
    if (err?.code === 'EEXIST') return false;
    throw err;
  }
}

/** Removes the STOP file in one unlink (no check-then-unlink race). Returns false when it was not there. */
function removeStopFile(stopFile: string): boolean {
  try {
    unlinkSync(stopFile);
    return true;
  } catch (err: any) {
    if (err?.code === 'ENOENT') return false;
    throw err;
  }
}

export async function cmdStop(opts: { json?: boolean } = {}): Promise<void> {
  const repoRoot = await getRepoRoot();
  const paths = getFactoryPaths(repoRoot);
  const json = opts.json ? { repo: await getGitHubRepo() } : undefined;
  ensureDir(paths.state);
  const before = !createStopFile(paths.stop);
  const after = true;
  logEventQuietly(
    paths.events,
    'stop-file-set',
    before ? 'factory stop: STOP already set (no-op)' : 'factory stop: STOP set — lanes halt between issues',
  );
  if (json) {
    console.log(JSON.stringify(buildStopResumeJson({ action: 'stop', repo: json.repo, before, after })));
    return;
  }
  console.log('STOP set — lanes halt between issues');
}

export async function cmdResume(issue?: string, opts: { json?: boolean; from?: string } = {}): Promise<void> {
  if (issue === undefined && opts.from !== undefined) {
    throw new CliExitError('factory: resume --from needs an issue number: factory resume <issue> --from check', 2);
  }
  if (issue !== undefined) {
    if (opts.from !== 'check') {
      throw new CliExitError('factory: resume <issue> only supports --from check (BUILD resume is #2320)', 2);
    }
    await resumeFromCheck(parseIssueArg(issue));
    return;
  }
  const repoRoot = await getRepoRoot();
  const paths = getFactoryPaths(repoRoot);
  const json = opts.json ? { repo: await getGitHubRepo() } : undefined;
  const before = removeStopFile(paths.stop);
  const after = false;
  if (existsSync(paths.root)) {
    logEventQuietly(
      paths.events,
      'stop-file-cleared',
      before ? 'factory resume: STOP cleared' : 'factory resume: STOP was not set (no-op)',
    );
  }
  if (json) {
    console.log(JSON.stringify(buildStopResumeJson({ action: 'resume', repo: json.repo, before, after })));
    return;
  }
  console.log('STOP cleared');
}

/** `factory resume <issue> --from check` (#2564): re-run CHECK and later phases on the kept worktree.
 *  `--json` only applies to the STOP form and is ignored here. */
async function resumeFromCheck(issueNum: number): Promise<void> {
  if (availableAgentClis(coreOps.isCommandAvailable).length === 0) {
    throw new CliExitError(`factory: ${missingAgentCliMessage()}`, 2);
  }
  const repoRoot = await getRepoRoot();
  const paths = getFactoryPaths(repoRoot);
  if (!existsSync(paths.root)) {
    throw new CliExitError(`factory: ${notInitializedMessage()}`, 2);
  }
  const record = await createCheckResumeStore(resolve(paths.plans, `issue-${issueNum}.md`)).load();
  if (!record || !existsSync(record.worktree)) {
    throw new CliExitError(
      `factory: no preserved build for #${issueNum} — nothing to resume; run factory run-issue ${issueNum}`,
      2,
    );
  }

  await withRepoRunLock(paths, 'factory resume', async () => {
    const ghRepo = await getGitHubRepo();
    const workSources = createDefaultWorkSourceRegistry({ octokit: getOctokit() });
    let work: WorkRequest;
    try {
      work = await workSources.resolve(GITHUB_ISSUE_SOURCE, {
        repo: ghRepo,
        issue: issueNum,
      } satisfies GithubIssueParams);
    } catch (err) {
      if (err instanceof InvalidWorkRequestInputError) {
        throw new CliExitError(`factory: ${err.message}`, 2);
      }
      throw new CliExitError(
        `factory: could not resolve issue #${issueNum} in ${ghRepo} (${errorDetail(err)}) — nothing was resumed`,
        2,
      );
    }
    try {
      await shipIssue(issueNum, {}, { repoRoot, ghRepo, workRequest: work, resumeFrom: record });
    } catch (err: any) {
      if (err instanceof IssueSkippedError) return;
      throw new CliExitError(`Resume failed for issue #${issueNum}: ${err.message}`, 1);
    }
  });
}

/** index.ts bindings the commander registrations in program*.ts call (#2793); type-only imports there avoid a runtime cycle. */
/** `factory supervise` (#2797): the handler lives in ./supervise.ts; this binds its runtime. */
function runSupervise(opts: SuperviseOptions): Promise<void> {
  return cmdSupervise(opts, {
    configLoaders,
    getRepoRoot: () => getRepoRoot(),
    getGitHubRepo: () => getGitHubRepo(),
    getOctokit: () => getOctokit(),
    branchPrefixOrExit,
    warnQueueDiagnostics,
    resolveUsageKnobs,
    usageFlagOverrides,
    withRepoRunLock,
    superviseLoop,
    createSuperviseRunQueue,
    createIngestHook,
    cmdRun: (o) => cmdRun(o),
    CliExitError,
  });
}

/** `factory status` (#2798): the handler lives in ./status.ts; this binds its runtime. */
function runStatus(opts: StatusOptions = {}): Promise<void> {
  return cmdStatus(opts, {
    configLoaders,
    ModelRouter: coreOps.ModelRouter,
    readCosts: internalOps.readCosts,
    getRepoRoot: () => getRepoRoot(),
    getGitHubRepo: () => getGitHubRepo(),
    getOctokit: () => getOctokit(),
    hasGitHubToken: () => hasGitHubToken(),
    readActiveProduct,
    warnQueueDiagnostics,
    errorDetail,
    CliExitError,
  });
}

/** `factory doctor` (#2799): the handler lives in ./doctor.ts; this binds its runtime. */
function runDoctor(opts: { reconcile?: boolean; probeInference?: boolean } = {}): Promise<void> {
  return cmdDoctor(opts, {
    shellOps,
    coreOps,
    internalOps,
    configLoaders,
    getGitHubRepo: () => getGitHubRepo(),
    getOctokit: () => getOctokit(),
    hasGitHubToken: () => hasGitHubToken(),
    scanGreenPrs,
    probeClaudeKeychain,
    toLeaseRow,
    gcWorktreeSandbox,
    repoConfigFileFor,
    isCommandAvailableViaShell,
  });
}

export const PROGRAM_HANDLERS = {
  cmdInit,
  cmdMigrate,
  cmdConstitution,
  cmdModels,
  cmdDoctor: runDoctor,
  cmdCost,
  cmdUsage,
  cmdStatus: runStatus,
  cmdRuns,
  cmdKpis,
  cmdClassifierReport,
  cmdClassifierBacktestEntry,
  cmdGarden,
  cmdTui,
  cmdLogs,
  cmdFeedback,
  cmdFilingPreview,
  cmdTriage,
  cmdTriageAccept,
  cmdUnpark,
  cmdQueueMigrate,
  cmdQueueAdd,
  cmdQueueReconcile,
  cmdQueueList,
  cmdQueueClear,
  cmdHostedSmoke,
  cmdHostedRunner,
  cmdHostedQueue,
  cmdCheck,
  cmdShip,
  cmdRunIssue,
  cmdRunBrief,
  cmdLocalSmallDryRun,
  cmdLocalSmallOvernight,
  cmdLand,
  cmdResumeApproved,
  cmdRun,
  cmdProxy,
  cmdFactoryd,
  cmdDaemonStart,
  cmdDaemonStop,
  cmdDaemonStatus,
  cmdDaemonLogs,
  cmdSelfUpdateCheck,
  cmdWorktreeGc,
  cmdReset,
  cmdSupervise: runSupervise,
  cmdStop,
  cmdResume,
  parseIssueArg,
  getRepoRoot,
  getCliVersion,
  CliExitError,
  PREREQUISITES_TEXT,
  HELP_FOOTER_TEXT,
};
export type ProgramHandlers = typeof PROGRAM_HANDLERS;

// ---------- main ----------

export async function main(argv: string[] = process.argv, deps: CliDeps = {}) {
  if (argv.slice(2).length === 0) {
    console.log(formatOverview());
    return;
  }

  const staleExit = runStalenessGuard({
    entryUrl: import.meta.url,
    env: process.env,
    argv,
    error: (m) => console.error(styleText('red', m)),
    warn: (m) => console.error(styleText('yellow', m)),
  });
  if (staleExit !== null) {
    process.exitCode = staleExit;
    return;
  }

  const program = buildProgram(PROGRAM_HANDLERS, deps);

  const previousLoaders = configLoaders;
  const previousGitOps = gitOps;
  const previousInternalOps = internalOps;
  const previousShellOps = shellOps;
  const previousCoreOps = coreOps;
  const previousPhaseOps = phaseOps;
  const previousOctokitFactory = octokitFactory;
  configLoaders = resolveConfigLoaders(deps, DEFAULT_CONFIG_LOADERS);
  gitOps = resolveGitOps(deps, DEFAULT_GIT_OPS);
  internalOps = resolveInternalOps(deps, DEFAULT_INTERNAL_OPS);
  shellOps = resolveShellOps(deps, DEFAULT_SHELL_OPS);
  coreOps = resolveCoreOps(deps, DEFAULT_CORE_OPS);
  phaseOps = resolvePhaseOps(deps, DEFAULT_PHASE_OPS);
  octokitFactory = deps.octokit;
  try {
    await program.parseAsync(argv);
  } catch (err) {
    if (err instanceof CliExitError) {
      console.error(styleText('red', err.message));
      process.exitCode = err.code;
      return;
    }
    throw err;
  } finally {
    configLoaders = previousLoaders;
    gitOps = previousGitOps;
    internalOps = previousInternalOps;
    shellOps = previousShellOps;
    coreOps = previousCoreOps;
    octokitFactory = previousOctokitFactory;
    phaseOps = previousPhaseOps;
  }
}
