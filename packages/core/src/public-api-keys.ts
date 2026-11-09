// src/public-api-keys.ts — expected ./testing and ./kpis export names, split from public-api.test.ts
export const TESTING_API_KEYS = [
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

/** Root names added by the canonical run lifecycle state machine (ADR-0177). */
export const LIFECYCLE_API_KEYS = [
  'assertLifecycleTransition',
  'canTransitionLifecycle',
  'describeLifecycle',
  'FINAL_LIFECYCLE_STATES',
  'fromLaneStatus',
  'fromRunStatus',
  'isFinalLifecycleState',
  'isResumableLifecycleState',
  'isTerminalLifecycleState',
  'laneStatusFromLifecycle',
  'LIFECYCLE_LABELS',
  'LIFECYCLE_STATES',
  'LIFECYCLE_TRANSITIONS',
  'LifecycleTransitionError',
  'prRunStatusFromLifecycle',
  'RESUMABLE_LIFECYCLE_STATES',
  'TERMINAL_LIFECYCLE_STATES',
  'toRunStatus',
];
