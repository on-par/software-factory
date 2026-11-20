// src/public-api-keys.ts — expected ./testing and ./kpis export names, split from public-api.test.ts
export const TESTING_API_KEYS = [
  'loadReusablePlan', // #4025
  'StubModelExecutor',
  'StubCodingHarness',
  'codingHarnessContractCases',
  'makeContractRequest',
  'loadInjectionFixtures',
  'SimModelExecutor',
  'createSimOctokit',
  'createFakeGitHub',
  'githubError',
  'createSimWorkspace',
  'simWorkspace',
  'failOnCall',
  'fakeOctokit',
  'realSimClock',
  'resolveLatencyMs',
  'applyLatency',
  'simCommitAll',
];
// The root "// KPIs" block (PUBLIC_API_KEYS above), re-exported from a Node-dep-free entry point (no harness/router deps).
export const KPIS_API_KEYS = [
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
];

/** ./internal names added by the `/factory iterate` trigger (#3625) and the awaiting-ci re-check (#3208). */
export const ITERATE_INTERNAL_KEYS = [
  'claimIterateCommand',
  'pollIterateCommands',
  'createOctokitIterateGitHub',
  'createFileIterateStore',
  'awaitingCiFile',
  'clearAwaitingCi',
  'nextRecheckAt',
  'readAwaitingCi',
  'resolveAwaitingCiCapMs',
  'upsertAwaitingCi',
  'hasAnyCiSignal',
  'listAllCheckRuns',
  'classifyHeadChecks',
  'fetchRequiredContexts',
  'warnNoBranchProtectionOnce',
  'ciReworkRoundsFor',
];

/** ./internal names added by the land-deferred retry queue (#3957). */
export const LAND_DEFERRED_INTERNAL_KEYS = [
  'DEFAULT_MAX_LAND_DEFERRALS',
  'clearLandDeferred',
  'decideLandDeferral',
  'dueLandDeferrals',
  'landDeferredFile',
  'readLandDeferred',
  'resolveMaxLandDeferrals',
  'upsertLandDeferred',
];

/** Root names added by the WorkKey identity (ADR-0168, #3639). */
export const WORK_KEY_API_KEYS = ['isNumericWorkKey', 'issueNumberOf', 'toWorkKey', 'workKeyFromIssue'];
export const DEPRECATED_PUBLIC_API_KEYS =
  'AUTHORITY_REDACTION_MASK BENCHMARK_MANIFEST_VERSION DEFAULT_DEFECT_WINDOW_DAYS DOCKER_SANDBOX_RUNTIME EPIC_REQUIRED_FIELDS EVENT_TRAITS FACTORY_BUG_REQUIRED_FIELDS HARNESS_CATALOG HUMAN_EVENT_TYPES HarnessError KPI_DRIFT_THRESHOLD_RATIO KPI_DRIFT_WINDOW_SIZE MAX_ATTACHMENT_BYTES PLAN_SPEC_PREVIEW_BYTES PolicyConfirmationRequiredError PortLeaseError ProcessGroupTracker REGRESSION_ISSUE_MARKER REGRESSION_ISSUE_TITLE REPO_INSTRUCTION_FILES SAFE_POLICY_FIELDS UNKNOWN_EVENT_TRAITS UnsupportedWorkSourceError WorkSourceRegistry accessibilityChecker acquireLaneEnvironment aggregateShipPhaseBreakdown appendHistoryLine applySteering assessAcceptanceCriteria buildBenchmarkManifest buildConstitutionContext buildLocalSmallScoreboard classifierOutcomeBucket compareToBaseline compileChecker computeKpiDrift computeSandboxAbReport createFsBriefReader createGithubIssueAdapter createLifecycleBus createLocalBriefAdapter createOctokitIssueClient decideBuildRoute defaultIsPortFree defaultIsProcessGroupAlive describeSteering designSmellsChecker eventTraitsFor failoversFrom formatRegressionIssue gateBuildOnBreaker gatherEvidencePack headlessEnv isDefectWindowClosed isHumanEvent isParkKind isRouteAsserted isSafePolicyFieldId issueFromFactoryBranch killProcessGroup laneContainerName laneHostname leaseEnv lifecycleBus linksChecker lintChecker loadGoldenCases parseHistory parseResetCooldownMs policyConfirmationFor readIssueEvents readProxyState recommendSandboxAb redactSecrets renderEvidencePack renderKpiDriftLine renderLocalRunReport renderLocalSmallScoreboardMarkdown renderSandboxAbReport renderShipPhaseBreakdown renderTrend resolveModelOverrides resolveSafeRepoPolicy rewriteQueueForDecomposition routeForBuildModel runAllCheckers runCustomChecker runEval runHarnessProbe setSafeRepoPolicyField steeringFileFor summaryToHistoryRecord testsChecker toBaseline toWorkKey touchedFilesFrom'.split(
    ' ',
  );
