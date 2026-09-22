import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import * as publicApi from './index.js';
import * as internalApi from './internal.js';
import * as kpisApi from './kpis-entry.js';
import * as testingApi from './testing.js';

// Pins the exact export surface of each @on-par/factory-core entry point
// (ADR-0004). Object.keys(...) only reflects runtime values — type-only
// exports (export type ...) don't appear at runtime, so these allowlists
// list value exports only.

const PUBLIC_API_KEYS = [
  // Config
  'FactoryConfigV2Schema',
  'factoryConfigV2JsonSchema',
  'getConstitutionsDir',
  'getFactoryPaths',
  'loadFactoryConfig',
  'loadFactoryConfigForRepo',
  'loadModelsConfig',
  'loadRoutesConfig',
  'loadV2Config',
  'parseV2Config',
  'resolveAdrMandate',
  'resolveAutoFailover',
  'resolveDefectWindowDays',
  'resolveEnvironmentPorts',
  'resolveEnvironmentProxy',
  'resolveIngestConfig',
  'resolveMergePolicy',
  'resolvePlanApproval',
  'resolveProcessGroupGraceMs',
  'resolveSkipCI',
  'resolveTimeouts',
  // Repo config (.factory/config.json)
  'applyRepoConfig',
  'describeEffectiveConfig',
  'loadRepoConfig',
  'resolveCodexDisabled',
  'resolveEfficiencyPolicy',
  'resolveEffectiveBuildRoute',
  'resolveEffectiveModelPins',
  'resolveUsageCap',
  'resolveWatchdogPolicy',
  'routeForBuildModel',
  'isSafePolicyFieldId',
  'policyConfirmationFor',
  'PolicyConfirmationRequiredError',
  'resolveSafeRepoPolicy',
  'SAFE_POLICY_FIELDS',
  'setSafeRepoPolicyField',
  // Environment
  'acquirePortLease',
  'defaultFindPortListeners',
  'defaultIsPidAlive',
  'defaultIsPortFree',
  'defaultIsProcessGroupAlive',
  'headlessEnv',
  'inspectPortLeases',
  'killProcessGroup',
  'laneEnv',
  'leaseEnv',
  'PortLeaseError',
  'ProcessGroupTracker',
  'reapOrphanProcesses',
  'reapStalePortLeases',
  'readPortLeases',
  'recordLeasePgid',
  'releasePortLease',
  // Proxy
  'clearProxyState',
  'createLaneProxy',
  'isProxyRunning',
  'laneBaseUrl',
  'laneHostLabel',
  'laneHostname',
  'readProxyState',
  'writeProxyState',
  // Queue
  'parseQueue',
  'readQueue',
  'redactSecretPatterns',
  'rewriteQueueForDecomposition',
  'validateQueue',
  // Queue activity (#1342)
  'DEFAULT_QUEUE_ACTIVITY_STALE_THRESHOLD_MS',
  'partitionLocalQueueByActivity',
  // Hosted execution (control plane)
  'createHostedJobStore',
  'createSqliteHostedJobStore',
  'hostedExecEnabled',
  'laneContainerName',
  'provisionLaneContainer',
  'resolveHostedJobStore',
  'runContainerJob',
  'runDockerRunner',
  'runFakeRunner',
  'runHostedSmoke',
  'runWatchdogSweep',
  'summarizeHostedJob',
  'summarizeHostedJobs',
  'AUTHORITY_REDACTION_MASK',
  'redactSecrets',
  'withAuthority',
  'prepareGitHubAuthority',
  'prototypeFallbackMint',
  'redactGitHubCredential',
  'resolveHostedAuthority',
  'createHostedControlPlaneServer',
  'handleHostedControlPlaneRequest',
  'createHttpHostedControlPlaneClient',
  'runOneJobRunner',
  'createHttpHostedJobClient',
  'queueAndTailJob',
  // Work requests
  'closedWorkSkipReason',
  'createDefaultWorkSourceRegistry',
  'createFsBriefReader',
  'createGithubIssueAdapter',
  'createLocalBriefAdapter',
  'createOctokitIssueClient',
  'GITHUB_ISSUE_SOURCE',
  'InvalidWorkRequestInputError',
  'InvalidWorkspaceError',
  'LOCAL_BRIEF_SOURCE',
  'resolveLocalOnlyPolicy',
  'UnsupportedWorkSourceError',
  'WorkSourceRegistry',
  // Events
  'followEvents',
  'readEvents',
  'eventTraitsFor',
  'EVENT_TRAITS',
  'isParkKind',
  'laneStatusOf',
  'severityOf',
  'UNKNOWN_EVENT_TRAITS',
  // Run outcome
  'parkEvents',
  'parkReasonFor',
  // Run ports (#674)
  'localOnlyWorkspace',
  'worktreeWorkspace',
  // Run composition (#675)
  'runIssue',
  // Run phase snapshot (#1325, #1326, #1327)
  'phaseSnapshotFile',
  'readPhaseSnapshot',
  'summarizeEvent',
  'touchLastEvent',
  'touchRunActivity',
  'writePhaseSnapshot',
  // Lifecycle bus (#591)
  'createLifecycleBus',
  'lifecycleBus',
  // Models
  'diagnoseModels',
  'isCommandAvailable',
  'ModelRegistry',
  'resolveModelOverrides',
  // Router
  'failoversFrom',
  'ModelRouter',
  // Provider circuit breaker
  'gateBuildOnBreaker',
  'parseResetCooldownMs',
  'ProviderBreaker',
  // Cross-run failure-signature memory
  'ReworkHistory',
  // Same-file lane guard
  'LaneFileGuard',
  'touchedFilesFrom',
  // Harness contract
  'HARNESS_CATALOG',
  'HarnessError',
  'KNOWN_HARNESS_IDS',
  // Constitutions
  'buildConstitutionContext',
  'ConstitutionLoader',
  'REPO_INSTRUCTION_FILES',
  // Sandbox
  'detectSandboxRuntime',
  'resolveSandboxPolicy',
  // Readiness
  'EPIC_REQUIRED_FIELDS',
  'FACTORY_BUG_REQUIRED_FIELDS',
  'FACTORY_TASK_REQUIRED_FIELDS',
  'scoreIssueReadiness',
  // Checkers
  'accessibilityChecker',
  'compileChecker',
  'designSmellsChecker',
  'linksChecker',
  'lintChecker',
  'runAllCheckers',
  'runCustomChecker',
  'testsChecker',
  // Phases
  'buildPhase',
  'checkPhase',
  'planPhase',
  'shipPhase',
  // Approvals
  'createFileApprovalGate',
  'listPendingApprovals',
  'PLAN_SPEC_PREVIEW_BYTES',
  'respondToApproval',
  // Steering
  'applySteering',
  'describeSteering',
  'drainSteering',
  'extractPathCandidates',
  'listQueuedSteering',
  'MAX_ATTACHMENT_BYTES',
  'queueSteeringMessage',
  'steeringFileFor',
  // Reports
  'BENCHMARK_MANIFEST_VERSION',
  'buildBenchmarkManifest',
  'computeSandboxAbReport',
  'DOCKER_SANDBOX_RUNTIME',
  'gatherEvidencePack',
  'InvalidArtifactsDirError',
  'readIssueEvents',
  'recommendSandboxAb',
  'renderEvidencePack',
  'renderLocalRunReport',
  'renderSandboxAbReport',
  'resolveArtifactsDir',
  'writeBenchmarkArtifacts',
  'writeLocalRunReport',
  'aggregateShipPhaseBreakdown',
  'renderShipPhaseBreakdown',
  // KPIs
  'appendKpiHistoryLine',
  'computeHealthKpis',
  'computeKpiDrift',
  'DEFAULT_DEFECT_WINDOW_DAYS',
  'detectPostMergeDefects',
  'fetchDefectSources',
  'fetchHumanEventSources',
  'formatKpiLines',
  'hasUnresolvedPark',
  'HUMAN_EVENT_TYPES',
  'isDefectWindowClosed',
  'isHumanEvent',
  'KPI_DRIFT_THRESHOLD_RATIO',
  'KPI_DRIFT_WINDOW_SIZE',
  'kpisToHistoryRecord',
  'mergedPrRefs',
  'parseKpiHistory',
  'reconstructHumanEvents',
  'renderKpiDriftLine',
  'renderKpiReport',
  'renderKpiTrend',
  // Ingest
  'issueFromFactoryBranch',
  'runAutoIngest',
  // Eval
  'appendHistoryLine',
  'buildLocalSmallScoreboard',
  'compareToBaseline',
  'formatRegressionIssue',
  'isRouteAsserted',
  'loadGoldenCases',
  'parseHistory',
  'REGRESSION_ISSUE_MARKER',
  'REGRESSION_ISSUE_TITLE',
  'renderLocalSmallScoreboardMarkdown',
  'renderTrend',
  'runEval',
  'summaryToHistoryRecord',
  'toBaseline',
  // Logger
  'createLogger',
  // Usage
  'aggregateCosts',
  'estimateTrailingSpend',
  'formatUsageReport',
  'readCostsFile',
  'readUsage',
  'watchUsage',
  'fetchSubscriptionUsage',
];

const INTERNAL_API_KEYS = [
  // Failure fingerprint & evidence
  'captureFailure',
  'fingerprintFailure',
  'normalizeFailureMessage',
  // Auto-file a fingerprinted bug (#373)
  'createOctokitFilingClient',
  'DEFAULT_BUG_LABELS',
  'DEFAULT_INTERNAL_REPO',
  'fileBug',
  'findMatchingIssue',
  'fingerprintMarker',
  'renderBugBody',
  'renderOccurrenceComment',
  'resolveTargetRepo',
  // Filing policy: when to file, caps, and self-fix labeling (#374)
  'DEFAULT_FILING_POLICY',
  'emptyLedger',
  'evaluateFilingPolicy',
  'isAutoMergeBlocked',
  'labelsFor',
  'recordFiled',
  'recordPark',
  'rollDay',
  'touchesSensitiveScope',
  // Config
  'resolveFilingPolicy',
  'resolveBranchPrefix',
  'resolveEffectiveConfig',
  'resolveExperimental',
  'resolveLocalOnly',
  // Design artifact (#422)
  'DesignArtifactSchema',
  'parseDesignArtifact',
  'readDesignArtifact',
  'renderDesignArtifact',
  // Concrete coding harnesses
  'classifyFailure',
  'ClaudeCliHarness',
  'CodexCliHarness',
  'isAgenticHarness',
  'isRetryableFailure',
  'NON_RETRYABLE_FAILURE_REASONS',
  'OllamaAgenticHarness',
  'PATCH_PROPOSAL_SCHEMA',
  'OllamaHttpHarness',
  'OpenCodeHarness',
  // Hosted execution: Docker container engine adapter (#899)
  'createDockerEngine',
  // Hosted execution: orphan sf-job-* container scan + reap (#1527)
  'listOrphanContainers',
  'reapOrphanContainers',
  // Router
  'CliModelExecutor',
  // Phase helpers
  'buildPlanPrompt',
  // Local-small harness
  'createLocalSmallDryRun',
  'runOvernightQueue',
  // Eval internals
  'judgeSpec',
  'median',
  'runJudgeSamples',
  'scoreSpec',
  // Usage internals
  'defaultTranscriptRoots',
  'priceFor',
  'TRAILING_WINDOW_MS',
  'readClaudeAccessToken',
  // Daemon repo registry (#781)
  'defaultRegistryPath',
  'dispatchableRepos',
  'emptyRegistry',
  'getRepo',
  'listRepos',
  'loadRegistry',
  'upsertRepo',
  'writeRegistry',
  // Daemon control-plane HTTP server (#777)
  'createFactorydServer',
  'createRunRuntime',
  'createShipExecutor',
  'DEFAULT_FACTORYD_PORT',
  // Durable explicit daemon runs (#1393)
  'createDaemonRunExclusive',
  'daemonRunFile',
  'executeDaemonRun',
  'isValidRunId',
  'MAX_DETAIL_CHARS',
  'readDaemonRun',
  'submitDaemonRun',
  'writeDaemonRun',
  // Daemon runtime state: pid/port/log files (#1177)
  'acquirePidFile',
  'createDaemonLogSink',
  'daemonRuntimePaths',
  'releaseRuntimeFiles',
  'writePortFile',
  // Daemon lane state resolution (#843)
  'createDaemonLaneContext',
  // Daemon attach gate (#778)
  'attachRepo',
  'parseRemoteSlug',
  'readOriginUrl',
  // Daemon checkout validation gate (#1398)
  'parseCheckoutRequest',
  'validateCheckout',
  // Daemon pause/resume gate (#779)
  'setRepoState',
  // Daemon detach gate (#780)
  'beginDetach',
  'DEFAULT_DRAIN_POLL_INTERVAL_MS',
  'DEFAULT_DRAIN_TIMEOUT_MS',
  'DRAIN_BLOCKING_STATUSES',
  'drainAndDetach',
  'isDrainSafe',
  // Utils
  'branchFor',
  'branchPrefixSlug',
  'cleanupWorktree',
  'colorEnabled',
  'defaultRemoteBase',
  'ensureDir',
  'escalationLine',
  'formatEventLine',
  'gitFetch',
  'isEscalation',
  'levelForType',
  'logCost',
  'logEvent',
  'readCosts',
  'setupWorktree',
  // docker-sandbox microVM lifecycle (#653)
  'createMicroVm',
  'microVmName',
  'removeMicroVm',
  'worktreeSandboxFor',
  // docker-sandbox orphan microVM scan + reap (#1527)
  'listMicroVms',
  'reapOrphanMicroVm',
  'shellEscape',
  'slugify',
  'watchChecks',
  'describeCommandFailure',
  'runCommand',
  'withFileLock',
  'withFileLockSync',
  'withGitLock',
  'readRunLockHolder',
  'RunLockHeldError',
  'withRunLock',
  'findCredentialFiles',
  'formatGcReport',
  'parseWorktreeList',
  'reapLaneWorktree',
  'scrubFile',
  'sweepWorktrees',
  'zeroFill',
  'checkRatchetDrift',
  'checkScopedRatchetDrift',
  'DEFAULT_RATCHET_SLACK',
  'parseCoverageSummary',
  'parseCoverageSummaryScopes',
  'renderRatchetReport',
  // GitHub-label-backed work queue (#824)
  'claimedByLabel',
  'CLAIMED_BY_LABEL_PREFIX',
  'claimExpiresLabel',
  'CLAIM_EXPIRES_LABEL_PREFIX',
  'createGithubQueue',
  'createOctokitQueueClient',
  'defaultClaimantId',
  'DEFAULT_CLAIM_LEASE_MS',
  'IN_PROGRESS_LABEL',
  'LANE_LABEL_PREFIX',
  'laneLabel',
  'MAX_LABEL_NAME_LENGTH',
  'parseClaimExpiresLabel',
  'PARKED_LABEL',
  'planQueueMigration',
  'QUEUED_LABEL',
  'QUEUE_ORDER_LABEL_PREFIX',
  'queueOrderLabel',
  'queueLabelSpecs',
  'readGithubQueueSnapshot',
  // Factory App admission-state compatibility (#1497)
  'ADMISSION_SNAPSHOT_VERSION',
  'ADMISSION_STATE_FILENAME',
  'classifyQueueCompatibility',
  'createFileAdmissionStateReader',
  'FACTORY_APP_REPAIR_HINT',
  'formatAdmissionConflict',
  'withAdmissionGuard',
  // Backend-agnostic queue seam (#1499)
  'createGithubQueueBackend',
  // Stale-claim reaping (#999, lease-based since #1500)
  'findStaleClaims',
  'releaseStaleClaims',
  // Green-and-ready PR reporting (#1000)
  'createOctokitGreenPrClient',
  'findUnmergedGreenPrs',
  'owningIssueForPr',
  // Sandbox command wrapping — used by the CLI's doctor probe (#1008)
  'wrapCommandInSandbox',
];

const TESTING_API_KEYS = [
  'StubModelExecutor',
  'StubCodingHarness',
  'codingHarnessContractCases',
  'makeContractRequest',
  'loadInjectionFixtures',
  'SimModelExecutor',
  'createSimOctokit',
  'createSimWorkspace',
  'failOnCall',
  'realSimClock',
  'resolveLatencyMs',
  'applyLatency',
  'runSimulation',
  'simCommitAll',
  'simDefaultScripts',
  'simModelsConfig',
  'simRoutesConfig',
  'simSpecContent',
  'SIM_FAILURE_MODES',
  'SIM_MALFORMED_OUTPUT',
  'SimJitter',
  'SimJitterExecutor',
  'createSeededRandom',
  'deriveSimSeed',
  'withSimJitter',
  'aggregateMonteCarlo',
  'monteCarloExitCode',
  'renderMonteCarloTable',
  'runMonteCarlo',
  'summarizeSimulationRun',
  'MONTE_CARLO_CLI_USAGE',
  'parseMonteCarloArgs',
  'runMonteCarloCli',
  'runShipPhaseBreakdownReportCli',
  'simMonteCarloIssues',
  'SIM_FENCED_ENRICHMENT_OUTPUT',
  'SIM_REGRESSION_FIXTURES',
  'simRegressionFixture',
  'simSpecWithObjectInterface',
];

// The same KPI functions the root export documents (see the "// KPIs" block in
// PUBLIC_API_KEYS above), re-exported standalone from a Node-dep-free entry point so
// browser bundlers can import them without pulling in the root's harness/router deps.
const KPIS_API_KEYS = [
  'appendKpiHistoryLine',
  'computeHealthKpis',
  'computeKpiDrift',
  'DEFAULT_DEFECT_WINDOW_DAYS',
  'detectPostMergeDefects',
  'fetchDefectSources',
  'fetchHumanEventSources',
  'formatKpiLines',
  'hasUnresolvedPark',
  'HUMAN_EVENT_TYPES',
  'isDefectWindowClosed',
  'isHumanEvent',
  'KPI_DRIFT_THRESHOLD_RATIO',
  'KPI_DRIFT_WINDOW_SIZE',
  'kpisToHistoryRecord',
  'mergedPrRefs',
  'parseKpiHistory',
  'reconstructHumanEvents',
  'renderKpiDriftLine',
  'renderKpiReport',
  'renderKpiTrend',
];

describe('public API surface (ADR-0004)', () => {
  it('root export exposes exactly the documented public API', () => {
    expect(Object.keys(publicApi).sort()).toEqual([...PUBLIC_API_KEYS].sort());
  });

  it('root export has no internal or testing symbols', () => {
    for (const key of [
      'ClaudeCliHarness',
      'CodexCliHarness',
      'StubModelExecutor',
      'StubCodingHarness',
      'codingHarnessContractCases',
      'shellEscape',
      'withGitLock',
      'buildPlanPrompt',
      'createLocalSmallDryRun',
      'judgeSpec',
    ]) {
      expect(Object.keys(publicApi)).not.toContain(key);
    }
  });

  it('./internal exposes exactly the documented internal API', () => {
    expect(Object.keys(internalApi).sort()).toEqual([...INTERNAL_API_KEYS].sort());
  });

  it('./testing exposes exactly the documented testing API', () => {
    expect(Object.keys(testingApi).sort()).toEqual([...TESTING_API_KEYS].sort());
  });

  it('./kpis exposes exactly the documented KPI subset, and nothing beyond the root API', () => {
    expect(Object.keys(kpisApi).sort()).toEqual([...KPIS_API_KEYS].sort());
    for (const key of KPIS_API_KEYS) {
      expect(Object.keys(publicApi)).toContain(key);
    }
  });

  it('package.json declares exactly the four documented entry points', () => {
    const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      exports: Record<string, { development: string; import: string; types: string }>;
    };
    expect(Object.keys(pkg.exports).sort()).toEqual(['.', './internal', './kpis', './testing'].sort());
    for (const entry of Object.values(pkg.exports)) {
      expect(Object.keys(entry).sort()).toEqual(['development', 'import', 'types']);
    }
  });
});
