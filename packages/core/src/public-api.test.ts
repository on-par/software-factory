import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as publicApi from './index.js';
import * as internalApi from './internal.js';
import * as kpisApi from './kpis-entry.js';
import * as testingApi from './testing.js';
import { ITERATE_INTERNAL_KEYS, KPIS_API_KEYS, TESTING_API_KEYS, WORK_KEY_API_KEYS } from './public-api-keys.js';
const PUBLIC_API_KEYS = [
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
  'resolveBuildPublish',
  'resolveSizeGateMode',
  'parseSizeGateMode',
  'parseMaxSlices',
  'resolveSizeGateBudget',
  'resolveSizeGateMaxSlices',
  'SIZE_GATE_MODES',
  'resolveDesignRegressionBlock',
  'resolveReadinessUpdateIssueBody',
  'resolvePlanApproval',
  'resolveProcessGroupGraceMs',
  'resolveCiWatchDeadlineMs',
  'resolveSkipCI',
  'resolveTimeouts',
  // Repo config (.factory/config.json)
  'applyRepoConfig',
  'describeEffectiveConfig',
  'loadRepoConfig',
  'resolveCodexDisabled',
  'resolveEfficiencyPolicy',
  'resolveLaneBreakerThreshold',
  'decideBuildRoute',
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
  'DEFAULT_QUEUE_ACTIVITY_STALE_THRESHOLD_MS',
  'partitionLocalQueueByActivity', // Queue activity (#1342)
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
  'acquireLaneEnvironment',
  'localOnlyWorkspace',
  'worktreeWorkspace',
  // Run composition (#675)
  'runIssue',
  'runStack',
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
  'diagnoseModels',
  'probeDeclaredHarnesses',
  'runHarnessProbe',
  'isCommandAvailable',
  'ModelRegistry',
  'resolveModelOverrides',
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
  'detectSandboxRuntime',
  'resolveSandboxPolicy',
  // Readiness
  'assessAcceptanceCriteria',
  'gradeIssueCriteria',
  'findIssueDependencies',
  'gradeIssueInvest',
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
  'createFileApprovalGate',
  'listPendingApprovals',
  'PLAN_SPEC_PREVIEW_BYTES',
  'respondToApproval',
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
  'classifierOutcomeBucket',
  'formatClassifierReport',
  'joinClassifierOutcomes',
  'KPI_DRIFT_THRESHOLD_RATIO',
  'KPI_DRIFT_WINDOW_SIZE',
  'kpiBranchPrefixes',
  'kpisToHistoryRecord',
  'mergeClassifierOutcomes',
  'mergedPrRefs',
  'parseClassifierOutcomes',
  'summarizeClassifierOutcomes',
  'parseKpiHistory',
  'reconstructHumanEvents',
  'reconstructKpiEvents',
  'renderKpiDriftLine',
  'renderKpiReport',
  'renderKpiTrend',
  // Discovery
  'DEFAULT_MAX_CANDIDATES',
  'runDiscoveryScan',
  'authorDraftEpic',
  'DEFAULT_OWNER_QUESTIONS',
  'DISCOVERY_LABEL',
  'EXPLORING_LABEL',
  'ideaMarker',
  'advanceDraftEpic',
  'ARCHIVED_LABEL',
  'classifyLifecycle',
  'DEFAULT_MAX_STORIES',
  'READY_LABEL',
  'renderStoryBody',
  'seedStories',
  'VALIDATED_LABEL',
  'WONTFIX_LABEL',
  // Ingest
  'issueFromFactoryBranch',
  'runAutoIngest',
  // Eval
  'appendHistoryLine',
  'buildLocalSmallScoreboard',
  'compareReadinessToBaseline',
  'compareToBaseline',
  'formatRegressionIssue',
  'isRouteAsserted',
  'loadGoldenCases',
  'loadReadinessCases',
  'parseHistory',
  'readinessStubSteps',
  'REGRESSION_ISSUE_MARKER',
  'REGRESSION_ISSUE_TITLE',
  'renderLocalSmallScoreboardMarkdown',
  'renderTrend',
  'runEval',
  'runReadinessEval',
  'summaryToHistoryRecord',
  'toBaseline',
  'toReadinessBaseline',
  'createLogger', // Logger
  'aggregateCosts',
  'formatCostTotal',
  'estimateTrailingSpend',
  'formatUsageReport',
  'readCostsFile',
  'readUsage',
  'watchUsage',
  'fetchSubscriptionUsage',
];
const JOB_KEYS = 'resolveHostMaxAgentJobs hostAgentJobsDir withHostAgentJobLease'.split(' ');
const TAIL =
  'InvalidEventCursorError eventSegmentFileName eventSegmentsDir readEventsTail readEventsSince listEventSegmentPaths'.split(
    ' ',
  );
const STEER = 'STEER_SOURCES STEER_PHASES SteerEventError appendSteerEvent'.split(' '); // #3400
const STEERED = 'collectMergedPrSteers summarizeSteerability formatSteerabilityReport fileBug'.split(' '); // #3403
const MORE = ['readStackSliceGate']; // #3366
const STACK = 'nextStackSlice restackAfterSquashMerge listStatelessLaneIssues'.split(' ');
const POLICY = 'isEgressEnforced describeDraftPrPolicy resolveDraftPrPolicy resolveConfiguredWritablePaths'.split(' '); // #2215, #3449, #3454
const PO2 = 'OPENCODE_GO_DEFAULT_MODEL filterRefusedProviders sweepOrphanDrafts'.split(' '); // #3335, #1623
const GATE = ['allProvidersDown', 'stageBlocked', 'PROVIDER_LEVEL_REASONS', 'TIMED_BREAKER_REASONS']; // #3226
const EXTRA_INTERNAL_KEYS = [
  ...JOB_KEYS,
  ...TAIL,
  ...MORE,
  ...STEER,
  ...STEERED,
  ...STACK,
  ...POLICY,
  ...PO2,
  ...GATE,
  ...ITERATE_INTERNAL_KEYS,
];
const INTERNAL_API_KEYS = [
  'listBlockedBy',
  ...'AGENT_MEMORY_DIR AGENT_MEMORY_MAX_BYTES agentMemoryPath readAgentMemory'.split(' '), // #3624
  ...'renderAgentMemory scanAgentMemory loadAgentMemoryCtx'.split(' '),
  ...'resolveCompileCommand resolveLintCommands resolveTestsCommand'.split(' '), // #3473, #1590
  ...'describeChecksProbe holdRunConfigSnapshot'.split(' '), // #3600
  // `factory init --detect-checks`: heuristics, agent prompt and reply, shell-free tokenizer
  ...'CHECK_KINDS buildDetectChecksPrompt detectCheckHeuristics heuristicProposal parseDetectedChecks'.split(' '),
  'tokenizeEvidenceCommand',
  ...'BaselineCache resolveBaselineCacheTtlHours'.split(' '), // #3540
  ...'openCodeVersion allProvidersDownReleasePayload'.split(' '), // #3340
  'fetchRequiredChecksVerdict', // #3186 CI lookup for a timed-out compile; base health (#2339) follows
  'BASE_HEALTH_CHECKERS',
  'checkBaseHealth',
  'codexChatgptSessionState',
  'hasClaudeLoginEvidence',
  // #3214
  'detectClaudePlan',
  'meteredPrimaryRouteWarnings',
  'providerPlan',
  'claudeStoredSessionState',
  // Last run-time local_auth failure per agent (#2733)
  'localAuthFailureSinceLogin',
  'recordLocalAuthFailure',
  'hasOpencodeLoginEvidence',
  // Persisted per-issue run state (#2271)
  'readIssueRunState',
  'nextIssueRunState',
  // Open factory draft PR count (#3553)
  'readOpenFactoryDrafts',
  'formatOpenFactoryDraftsLine',
  'runStateFile',
  'writeIssueRunState',
  'createPlanReuseStore',
  // Check-resume record (#2564)
  'createCheckResumeStore',
  // Garden harvest (#2083)
  'DEFAULT_GARDEN_MAX_CLUSTERS',
  'DEFAULT_GARDEN_SINCE',
  'capGardenClusters',
  'filterGardenWindow',
  'findAdoptablePr',
  'parseGardenDuration',
  'renderGardenJson',
  'clusterGarden',
  'readHarvestEvents',
  'renderGardenReport',
  // Garden dedup (#2102)
  'dedupGardenClusters',
  'filterGardenOnlyNew', // --only-new (#2104)
  'markGardenTrackingUnknown',
  // Readiness deep check (#1732)
  'buildDecompositionPrompt',
  'parseDecompositionOutput',
  // Command-run summary (#3328)
  'summarizeCommandRun',
  'parseCommandCounts',
  ...'lookupOpenPrByIssue lookupOpenPrByBranch'.split(' '), // open-PR lookup (#3439)
  ...'findDeclaredPrerequisites createOctokitBlockedParkStore pollBlockedParks'.split(' '), // blockers (#2316)
  ...Object.keys(await import('./queue/unpark.js')), // unpark (#2318)
  'judgeReadiness',
  // Slice plan model (ADR-0147)
  'STATE_ROOT_ENV',
  'currentSlice',
  'fileSlicePlanStore',
  'findSlicePlanComment',
  'publishParkComment',
  'recordSliceMerged',
  'renderSlicePlanComment',
  'resolveStateRoot',
  'upsertSlicePlanComment',
  'withSliceState',
  // Worktree location (#1758)
  'formatWorktreeLocation',
  'laneWorktreePath',
  'resolveWorktreeRoot',
  // Review verdict (#1679)
  'computeReviewVerdict',
  'DETERMINISTIC_CHECKERS',
  // Review floor (#1721)
  'computeReviewFloor',
  'DEFAULT_REVIEW_FLOOR_RULES',
  // Review fork-PR containment gate (#1684)
  'isCrossRepoPullRequest',
  'isForkPullRequest',
  'resolveReviewContainment',
  'REVIEW_CONTAINED_FLAG_HELP',
  'REVIEW_CONTAINMENT_REFUSED_EXIT_CODE',
  'runContainmentGatedReview',
  'pullRequestHeadRef',
  'runContainedReview',
  // Cross-repo PR references + review constitution (#1673)
  'DEFAULT_REVIEW_CONSTITUTION',
  // Default code constitution + checker list (#2387)
  'DEFAULT_CODE_CONSTITUTION',
  'describeConstitutionSource',
  'listBuiltInCheckers',
  'findUnknownConstitutionCheckers',
  'isTemplateToken',
  'harnessCliCommand',
  'isHarnessCliPresent',
  'lintFactoryConfig',
  'findConfigSchemaErrors',
  'findUnknownConfigKeyWarnings',
  'formatUnknownCheckerMessage',
  'describePullRequestAccessError',
  'describeReviewConstitutionSource',
  'formatPullRequestReference',
  'parsePullRequestReference',
  'resolvePullRequestReference',
  'REVIEW_ACCESS_ERROR_EXIT_CODE',
  // Local queue reprioritization audit records (#869)
  // Failure fingerprint & evidence
  // Auto-file a fingerprinted bug (#373)
  'createOctokitFilingClient',
  'DEFAULT_BUG_LABELS',
  'partitionGithubClaimsByActivity',
  // Evidence sanitizer for untrusted text (#1841, #1852)
  'stripHiddenContent',
  'buildUpstreamReport',
  'upstreamInputFromEvidence',
  // Filing policy: when to file, caps, and self-fix labeling (#374)
  'isAutoMergeBlocked',
  // Config
  'resolveFilingPolicy',
  'resolveHermeticGit',
  'resolvePrClassifierPolicy',
  'resolveReviewFloorRules',
  'resolveTrustTier',
  // PR classifier shadow verdict (#1725)
  'buildClassifierPrompt',
  'changedPathsFromDiff',
  'CLASSIFIER_PROMPT_VERSION',
  'classifierPolicyVersion',
  'classifyPrShadow',
  'parseClassifierOutput',
  'toClassificationRecord',
  // PR classifier backtest (#1728)
  'backtestFileName',
  'buildBacktestRecord',
  'parseBacktestLabels',
  'runClassifierBacktest',
  'selectBacktestPrs',
  // PR classifier routing (#1724)
  'classifiedRecords',
  'classifierGateReason',
  'parseNumstat',
  'readReviewFloorChanges',
  'resolveReviewRouting',
  'resolveBranchPrefix',
  'resolveEffectiveConfig',
  'resolveExperimental',
  'resolveLocalOnly',
  ...'resolveHostMaxBuilds resolveQueueClaimSettleMs evaluateRisk decideRiskMerge NEEDS_HUMAN_LABEL RISK_HIGH_LABEL RISK_MED_LABEL DEFAULT_MAX_CLOCK_SKEW_MS measureGithubClockSkew resolveQueueMaxClockSkewMs'.split(
    ' ',
  ), // #3380, #3381, #3149
  ...'RISK_RECEIPT_END RISK_RECEIPT_START listPrChangedFiles publishRiskReceipt renderRiskReceipt'.split(' '), // #3386
  ...'upsertRiskReceipt riskPolicyConfigFile loadRiskPolicy formatRiskPolicy'.split(' '), // #3387
  ...'resolveHostLoadGuard evaluateLoadGuard formatLoadHold readHostLoad resolveBaseHealthChecks'.split(' '), // #3048, #3290
  ...'hostBuildSlotsDir listHostSlots syncLandBranch listIssueRuns'.split(' '), // syncLandBranch: #1886; run readers: #3448
  ...'createRunSlotGate withRunAndHostBuildSlot formatDiskHold'.split(' '), // #3049, #2284
  ...'claimDiskAlert createDiskGuard'.split(' '), // #2284
  ...'FACTORY_RUNTIME_CONFIG_KEYS hostDiskAlertFile'.split(' '),
  'createOctokitCollaboratorPermissionClient',
  ...'renderConfigExample resolveT1SampleRate'.split(' '),
  'resolveEvidenceAllowlist',
  'runEvidencePlan',
  // Design artifact (#422)
  // Concrete coding harnesses
  'classifyFailure',
  'runHarnessCheck',
  'classifyOpenCodeErrorType',
  'parseOpenCodeJson',
  // Hosted execution: Docker container engine adapter (#899)
  'createDockerEngine',
  // Hosted execution: orphan sf-job-* container scan + reap (#1527)
  'listOrphanContainers',
  'reapOrphanContainers',
  // Router, phase helpers, triage prompt and queue normalization (#1650, #2981)
  'buildTriagePrompt',
  'dropQueuedIssues',
  'normalizeTriageQueue',
  'parseOpenPrIssues',
  'parseTriageCandidates',
  // Rate-limit-aware incremental KPI sweep
  'fetchHumanEventSourcesCached',
  'runProducedPrOrMerge',
  // Local-small harness
  'createLocalSmallDryRun',
  'runOvernightQueue',
  'REPO_CONFIG_YAML_HEADER',
  'migrateRepoConfigToYaml',
  'setRepoConfigValue',
  'rewriteRepoConfigFile',
  'readRepoConfigFile',
  'resolveRepoConfigPath',
  // Eval internals
  'median',
  // Usage internals
  'TRAILING_WINDOW_MS',
  'resolveRunUsageHarness',
  // Daemon repo registry (#781)
  'defaultRegistryPath',
  'listRepos',
  'loadRegistry',
  // Daemon control-plane HTTP server (#777)
  'createFactorydServer',
  'createRunRuntime',
  'findOpenPR',
  'settleParkedPullRequest',
  'parkPayload',
  'parkUnblockHint',
  'createShipExecutor',
  'DEFAULT_FACTORYD_PORT',
  // Durable explicit daemon runs (#1393)
  'daemonRunFile',
  'isValidRunId',
  'readDaemonRun',
  // Daemon runtime state: pid/port/log files (#1177)
  'acquirePidFile',
  'createDaemonLogSink',
  'daemonRuntimePaths',
  'releaseRuntimeFiles',
  'writePortFile',
  // Daemon attach gate (#778)
  'parseRemoteSlug',
  'readParkedOrder',
  // Utils
  'branchFor',
  'branchPrefixSlug',
  'cleanupWorktree',
  'colorEnabled',
  'defaultRemoteBase',
  'ensureDir',
  'factoryBranchIssue',
  'factoryBranchPrefixes',
  'formatEventLine',
  'getIssueTitle',
  'gitFetch',
  'logCost',
  'logEvent',
  'readCosts',
  'setupWorktree',
  'claudeConfigDirOverride',
  'claudeKeychainService',
  // docker-sandbox microVM lifecycle + orphan scan/reap (#653, #1527)
  'microVmName',
  'worktreeSandboxFor',
  'listMicroVms',
  'reapOrphanMicroVm',
  'shellEscape',
  'slugify',
  // report-only egress proxy for sandbox-exec (#2214)
  'startEgressProxy',
  'egressSummaryMessage',
  'egressHostMessage',
  'shouldProxyEgress',
  'claimReviewRework',
  'watchChecks',
  'watchChecksWithInfraRerun',
  'runCommand',
  ...'withFileLock withGitLock formatStopMarker readStopMarker'.split(' '),
  ...'RunLockHeldError withScopedRunLock runLockDirFor listLiveRunLocks'.split(' '),
  'countUnpushedCommits',
  'formatGcReport',
  'isWorktreeClean',
  'parseWorktreeList',
  'reapCleanShipWorktree',
  'reapLaneWorktree',
  'sweepWorktrees',
  ...'findWorktreeKeep removeWorktreeKeep upsertWorktreeKeep'.split(' '), // #3318
  'checkScopedRatchetDrift',
  'DEFAULT_RATCHET_SLACK',
  'parseCoverageSummaryScopes',
  'renderRatchetReport',
  // GitHub-label-backed work queue (#824)
  'CLAIM_EXPIRES_LABEL_PREFIX',
  'createGithubQueue',
  'createOctokitQueueClient',
  'createFileReviewReworkStore',
  'createOctokitReviewReworkGitHub',
  'pollReviewRework',
  'countReviewReworkRuns',
  'parkAtReviewReworkCap',
  'resolveMaxReviewReworkRuns',
  'reviewReworkCapMessage',
  'defaultClaimantId',
  'DEFAULT_CLAIM_LEASE_MS',
  'IN_PROGRESS_LABEL',
  'LANE_LABEL_PREFIX',
  'laneLabel',
  'laneSlug',
  'PARKED_LABEL',
  'planQueueMigration',
  'QUEUED_LABEL',
  'QUEUE_ORDER_LABEL_PREFIX',
  'queueOrderLabel',
  'readGithubQueueSnapshot',
  'formatQueueOrderConflict',
  // Factory App admission-state compatibility (#1497)
  'classifyQueueCompatibility',
  'createFileAdmissionStateReader',
  'createGithubLaneClaimStalenessProbe',
  'releaseLaneClaim',
  'formatAdmissionConflict',
  'formatBreakerRemaining',
  'withAdmissionGuard',
  // Backend-agnostic queue seam (#1499)
  // Stale-claim reaping (#999, lease-based since #1500)
  'releaseStaleClaims',
  'unqueueDeferredOnly',
  // Green-and-ready PR reporting (#1000)
  'createOctokitGreenPrClient',
  'findUnmergedGreenPrs',
  // Read-only GitHub ProjectV2 queue-intent polling (#847)
  // Board-constrained local lane dispatch (#848)
  // ProjectV2 queue-intent scheduler (#867)
  // Sandbox command wrapping — used by the CLI's doctor probe (#1008)
  'wrapCommandInSandbox',
];
describe('public API surface (ADR-0004)', () => {
  it('root export exposes exactly the documented public API', () => {
    expect(Object.keys(publicApi).sort()).toEqual([...PUBLIC_API_KEYS, ...WORK_KEY_API_KEYS].sort());
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
  it('./internal and ./testing expose exactly the documented APIs', () => {
    expect(Object.keys(internalApi).sort()).toEqual([...INTERNAL_API_KEYS, ...EXTRA_INTERNAL_KEYS].sort());
    expect(Object.keys(testingApi).sort()).toEqual([...TESTING_API_KEYS, 'createTempDirs', 'withTempDir'].sort());
  });
  it('./kpis exposes exactly the documented KPI subset, and nothing beyond the root API', () => {
    expect(Object.keys(kpisApi).sort()).toEqual([...KPIS_API_KEYS].sort());
    for (const key of KPIS_API_KEYS) expect(Object.keys(publicApi)).toContain(key);
  });
  it('package.json declares exactly the four documented entry points', () => {
    const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { exports: Record<string, Record<string, string>> };
    expect(Object.keys(pkg.exports).sort()).toEqual(['.', './internal', './kpis', './testing'].sort());
    for (const entry of Object.values(pkg.exports))
      expect(Object.keys(entry).sort()).toEqual(['development', 'import', 'types']);
  });
});
