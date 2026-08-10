// packages/core/src/kpis-entry.ts — Pure KPI derivation, re-exported standalone so
// browser bundlers (e.g. the dashboard) can import it without pulling in the root
// entry point's Node-only harness/router deps (execa, @octokit/rest). Re-exports the
// same "KPIs" section of the root public API (see ADR-0004) — no new surface, just a
// pure-only door to it.

export type {
  CommitSource,
  DefectSourceClient,
  DefectSources,
  HealthKpis,
  HumanSourceClient,
  KpiDriftMetricResult,
  KpiDriftReport,
  KpiHistoryRecord,
  MergedPrRef,
  PrCommentSource,
  PrSource,
  RepoCommitSource,
  RepoIssueSource,
} from './kpis/index.js';
export {
  appendKpiHistoryLine,
  computeHealthKpis,
  computeKpiDrift,
  DEFAULT_DEFECT_WINDOW_DAYS,
  detectPostMergeDefects,
  fetchDefectSources,
  fetchHumanEventSources,
  formatKpiLines,
  hasUnresolvedPark,
  HUMAN_EVENT_TYPES,
  isDefectWindowClosed,
  isHumanEvent,
  KPI_DRIFT_THRESHOLD_RATIO,
  KPI_DRIFT_WINDOW_SIZE,
  kpisToHistoryRecord,
  mergedPrRefs,
  parseKpiHistory,
  reconstructHumanEvents,
  renderKpiDriftLine,
  renderKpiReport,
  renderKpiTrend,
} from './kpis/index.js';
