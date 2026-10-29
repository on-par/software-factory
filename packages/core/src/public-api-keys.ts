// src/public-api-keys.ts — expected ./testing and ./kpis export names, split from public-api.test.ts
export const TESTING_API_KEYS = [
  'StubModelExecutor',
  'StubCodingHarness',
  'codingHarnessContractCases',
  'makeContractRequest',
  'loadInjectionFixtures',
  'SimModelExecutor',
  'createSimOctokit',
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

/** ./internal names added by the decomposed-parent criteria coverage (#3108). */
const PARENT_COVERAGE_INTERNAL_KEYS =
  'computeParentCoverage formatParentCoverageLine listDecomposedParentCoverage refreshParentCoverageAfterMerge renderParentCoverageComment'.split(
    ' ',
  );

/** ./internal names added by the `/factory iterate` trigger (#3625), the awaiting-ci re-check (#3208) and #3108. */
export const ITERATE_INTERNAL_KEYS = [
  ...PARENT_COVERAGE_INTERNAL_KEYS,
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

/** Root names added by the WorkKey identity (ADR-0168, #3639). */
export const WORK_KEY_API_KEYS = ['isNumericWorkKey', 'issueNumberOf', 'toWorkKey', 'workKeyFromIssue'];
