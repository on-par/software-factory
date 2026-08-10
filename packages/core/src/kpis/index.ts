// src/kpis/index.ts — Pure aggregation of factory health KPIs from events + cost rows

import type { CostEntry, FactoryEvent, ReadinessInfo, ReworkCauseTag, RetryCause } from '../types/index.js';
import { isHumanEvent } from './human.js';

export type { CommitSource, HumanSourceClient, PrSource } from './human.js';
export {
  fetchHumanEventSources,
  hasUnresolvedPark,
  HUMAN_EVENT_TYPES,
  isHumanEvent,
  reconstructHumanEvents,
} from './human.js';
export type {
  DefectSourceClient,
  DefectSources,
  MergedPrRef,
  PrCommentSource,
  RepoCommitSource,
  RepoIssueSource,
} from './defects.js';
export {
  DEFAULT_DEFECT_WINDOW_DAYS,
  detectPostMergeDefects,
  fetchDefectSources,
  isDefectWindowClosed,
  mergedPrRefs,
} from './defects.js';

function isRealIssue(issue: string): boolean {
  return /^\d+$/.test(issue);
}

const PHASE_ORDER = ['plan', 'build', 'check', 'ship'];

function percentileFromSorted(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function percentile(values: number[], p: number): number | null {
  return percentileFromSorted(
    [...values].sort((a, b) => a - b),
    p,
  );
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function formatDurationMs(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export interface HealthKpis {
  runs: number;
  merged: number;
  /** Runs that entered the rework loop at least once (breadth: run-level boolean —
   *  did it loop at all). See totalRetries/retriesByCause for depth + cause. */
  reworkRuns: number;
  stuckRuns: number;
  mergeRate: number;
  /** Share of runs that looped at all (breadth). Distinct from retries, which
   *  count how many times and why — both are kept intentionally. */
  reworkRate: number;
  /** Runs with at least one rework-triggering event tagged `merge-conflict` (#615). */
  collisionReworkRuns: number;
  /** collisionReworkRuns / runs; 0 when runs === 0 (#615). Tracked alongside
   *  reworkRate to measure how much rework is attributable to parallel-lane
   *  collisions, as opposed to legitimate checker failures. */
  collisionReworkRate: number;
  stuckRate: number;
  /** Share of runs with at least one explicit human-* event (#420). */
  humanInterventionRate: number;
  /** Runs with at least one explicit human-* event (#420). */
  humanTouchedRuns: number;
  /** Runs that merged with zero human events — the demo headline (#420). */
  fullyAutonomousRuns: number;
  /** Mean human events per run; null when runs === 0. */
  humanEventsPerRun: number | null;
  /** fullyAutonomousRuns / runs; 0 when runs === 0. */
  fullyAutonomousRate: number;
  totalCost: number;
  costPerMergedPr: number | null;
  medianCycleTimeMs: number | null;
  p90CycleTimeMs: number | null;
  phaseDurations: Record<string, number>;
  /** Total model-call cost per phase (plan/build/check/ship), from CostEntry rows
   *  mapped via phaseOfCostEntry() (#614). Only keys with at least one matching
   *  cost row are present. */
  phaseCosts: Record<string, number>;
  queueWaitMs: number | null;
  cycleTimeExcludedRuns: number;
  /** Total retry attempts across all runs, from retryCauseOf() over events. */
  totalRetries: number;
  /** Median retries per run (all runs, including zero-retry runs); null when runs === 0. */
  retriesPerRun: number | null;
  /** Retry counts per cause bucket; all four keys always present. */
  retriesByCause: Record<RetryCause, number>;
  /** Fraction of totalCost from CostEntry rows tied to retry attempts
   *  (rows with retryCause set or failoverReason set); 0 when totalCost is 0. */
  retryCostShare: number;
  /** Runs carrying at least one `readiness` event (#421). */
  readinessScoredRuns: number;
  /** Mean readiness score across scored runs; null when readinessScoredRuns === 0. */
  meanReadinessScore: number | null;
  /** Retries + cycle time split by readiness.pass, for correlating issue quality
   *  against factory outcomes (#421); null when readinessScoredRuns === 0. */
  readinessSplit: {
    ready: { runs: number; meanRetries: number | null; medianCycleTimeMs: number | null };
    notReady: { runs: number; meanRetries: number | null; medianCycleTimeMs: number | null };
  } | null;
  /** Runs whose readiness event carries an INVEST size verdict (`sizeOk` set, #605).
   *  Readiness events logged before #605 have no verdict and are excluded, not
   *  counted as passing. */
  sizeScoredRuns: number;
  /** Size-scored runs the gate flagged as too big (`sizeOk === false`) (#608). */
  sizeGateEscalatedRuns: number;
  /** sizeGateEscalatedRuns / runs — escalated issues over issues attempted (#608);
   *  0 when runs === 0. Denominator is `runs`, like every other rate here, so it is
   *  deliberately NOT the complement of meanSizeScore. */
  sizeGateEscalationRate: number;
  /** Mean per-run size score over sizeScoredRuns — 1 for an in-budget issue, 0 for an
   *  over-budget one; null when sizeScoredRuns === 0 (#608). */
  meanSizeScore: number | null;
  /** Merged runs whose post-merge defect window has closed — the only cohort that can be
   *  scored (#612). Runs still inside their window are excluded, not counted as clean. */
  defectWindowClosedRuns: number;
  /** Window-closed runs with at least one post-merge defect signal (#612). */
  postMergeDefectRuns: number;
  /** Total defect signals across those runs — a run can attract several (#612). */
  postMergeDefectSignals: number;
  /** postMergeDefectRuns / defectWindowClosedRuns; null when the cohort is empty (#612).
   *  Deliberately NOT on the `runs` denominator every other rate here uses — a run merged
   *  yesterday has no verdict yet. See ADR-0012. */
  postMergeDefectRate: number | null;
}

interface RunStats {
  merged: boolean;
  reworked: boolean;
  collisionReworked: boolean;
  stuck: boolean;
  humanEvents: number;
  firstTs: number | null;
  mergedTs: number | null;
  firstPhaseTs: number | null;
  phaseWindows: Map<string, { first: number; last: number }>;
  retries: number;
  readiness: ReadinessInfo | null;
  defectWindowClosed: boolean;
  defectSignals: number;
}

/** Maps a CostEntry's `task` to the pipeline phase it billed against (#614). */
const TASK_PHASE: Record<string, string> = {
  plan: 'plan',
  triage: 'plan',
  build_codex: 'build',
  build_claude: 'build',
  check_compile: 'check',
  check_tests: 'check',
  check_lint: 'check',
  check_accessibility: 'check',
  check_links: 'check',
  check_custom: 'check',
  check_design: 'check',
  dispute_resolution: 'check',
  review_pr: 'ship',
  security_review: 'ship',
};

/** Attributes one CostEntry to a phase, or null if the task isn't mapped.
 *  CHECK's rework-repair calls reuse the `build_claude` task (they run the
 *  same worker harness) but are tagged `retryCause: 'checker'`, so that
 *  signal — not the task name — decides they belong to `check` (#614). */
export function phaseOfCostEntry(entry: CostEntry): string | null {
  if (entry.retryCause === 'checker') return 'check';
  return TASK_PHASE[entry.task] ?? null;
}

/** Attribute one event to a retry-cause bucket, or null if it is not a retry.
 *  'rework' events are one checker retry per round; 'stuck' events repeat the
 *  same round's payload and must NOT count. Any event carrying failoverReason
 *  is a failover retry attempt, split out by timeout / unknown. */
export function retryCauseOf(event: FactoryEvent): RetryCause | null {
  if (event.type === 'rework') return 'checker';
  if (event.failoverReason === 'timeout') return 'timeout';
  if (event.failoverReason === 'unknown') return 'other';
  if (event.failoverReason) return 'failover';
  return null;
}

/** Tags a rework-triggering event's cause from the run's recorded failure/merge-state
 *  data (#615): a `conflict` event is the lane's branch colliding with a file another
 *  lane had already merged (a land-time rebase conflict, see rebaseDirtyPullRequest in
 *  the CLI); a `rework`/`stuck` event with failing checkers is a legitimate quality/test
 *  issue. Returns null for events that are not rework-triggering at all. */
export function reworkCauseTagOf(event: FactoryEvent): ReworkCauseTag | null {
  if (event.type === 'conflict') return 'merge-conflict';
  if (event.type === 'rework' || event.type === 'stuck' || event.rework) {
    return event.rework && event.rework.failingChecks.length > 0 ? 'checker-failure' : 'other';
  }
  return null;
}

export function computeHealthKpis(events: FactoryEvent[], costs: CostEntry[]): HealthKpis {
  const runsByIssue = new Map<string, RunStats>();
  const retriesByCause: Record<RetryCause, number> = { checker: 0, failover: 0, timeout: 0, other: 0 };

  for (const event of events) {
    if (!isRealIssue(event.issue)) continue;

    const stats = runsByIssue.get(event.issue) ?? {
      merged: false,
      reworked: false,
      collisionReworked: false,
      stuck: false,
      humanEvents: 0,
      firstTs: null,
      mergedTs: null,
      firstPhaseTs: null,
      phaseWindows: new Map<string, { first: number; last: number }>(),
      retries: 0,
      readiness: null,
      defectWindowClosed: false,
      defectSignals: 0,
    };

    if (event.type === 'merged' || event.type === 'human-merged') stats.merged = true;
    if (event.type === 'rework' || event.rework) stats.reworked = true;
    if (reworkCauseTagOf(event) === 'merge-conflict') stats.collisionReworked = true;
    if (event.type === 'stuck' || event.rework?.stuck === true) stats.stuck = true;
    if (isHumanEvent(event)) stats.humanEvents++;
    if (event.readiness) stats.readiness = event.readiness;
    if (event.type === 'defect-window-closed') stats.defectWindowClosed = true;
    if (event.type === 'post-merge-defect') stats.defectSignals++;

    const retryCause = retryCauseOf(event);
    if (retryCause) {
      stats.retries++;
      retriesByCause[retryCause]++;
    }

    const ts = Date.parse(event.ts);
    if (!Number.isNaN(ts)) {
      if (stats.firstTs === null || ts < stats.firstTs) stats.firstTs = ts;
      if ((event.type === 'merged' || event.type === 'human-merged') && stats.mergedTs === null) stats.mergedTs = ts;
      if (event.phase) {
        if (stats.firstPhaseTs === null || ts < stats.firstPhaseTs) stats.firstPhaseTs = ts;
        const window = stats.phaseWindows.get(event.phase);
        if (!window) {
          stats.phaseWindows.set(event.phase, { first: ts, last: ts });
        } else {
          if (ts < window.first) window.first = ts;
          if (ts > window.last) window.last = ts;
        }
      }
    }

    runsByIssue.set(event.issue, stats);
  }

  const runs = runsByIssue.size;
  let merged = 0;
  let reworkRuns = 0;
  let collisionReworkRuns = 0;
  let stuckRuns = 0;
  let humanTouchedRuns = 0;
  let fullyAutonomousRuns = 0;
  let totalHumanEvents = 0;
  const cycleTimes: number[] = [];
  const queueWaits: number[] = [];
  const phaseSamples = new Map<string, number[]>();
  const perRunRetryCounts: number[] = [];
  const readinessScores: number[] = [];
  const readyRetries: number[] = [];
  const readyCycleTimes: number[] = [];
  const notReadyRetries: number[] = [];
  const notReadyCycleTimes: number[] = [];
  const sizeScores: number[] = [];
  let sizeGateEscalatedRuns = 0;
  let defectWindowClosedRuns = 0;
  let postMergeDefectRuns = 0;
  let postMergeDefectSignals = 0;

  for (const stats of runsByIssue.values()) {
    if (stats.merged) merged++;
    if (stats.reworked) reworkRuns++;
    if (stats.collisionReworked) collisionReworkRuns++;
    if (stats.stuck) stuckRuns++;
    if (stats.humanEvents > 0) humanTouchedRuns++;
    if (stats.merged && stats.humanEvents === 0) fullyAutonomousRuns++;
    totalHumanEvents += stats.humanEvents;
    perRunRetryCounts.push(stats.retries);

    const runCycleTime =
      stats.firstTs !== null && stats.mergedTs !== null ? Math.max(0, stats.mergedTs - stats.firstTs) : null;
    if (runCycleTime !== null) cycleTimes.push(runCycleTime);
    if (stats.firstTs !== null && stats.firstPhaseTs !== null) {
      queueWaits.push(Math.max(0, stats.firstPhaseTs - stats.firstTs));
    }
    for (const [phase, window] of stats.phaseWindows) {
      const samples = phaseSamples.get(phase) ?? [];
      samples.push(Math.max(0, window.last - window.first));
      phaseSamples.set(phase, samples);
    }

    if (stats.readiness) {
      readinessScores.push(stats.readiness.score);
      const cohortRetries = stats.readiness.pass ? readyRetries : notReadyRetries;
      const cohortCycleTimes = stats.readiness.pass ? readyCycleTimes : notReadyCycleTimes;
      cohortRetries.push(stats.retries);
      if (runCycleTime !== null) cohortCycleTimes.push(runCycleTime);
    }

    if (stats.readiness?.sizeOk !== undefined) {
      sizeScores.push(stats.readiness.sizeOk ? 1 : 0);
      if (!stats.readiness.sizeOk) sizeGateEscalatedRuns++;
    }

    if (stats.defectWindowClosed) {
      defectWindowClosedRuns++;
      if (stats.defectSignals > 0) {
        postMergeDefectRuns++;
        postMergeDefectSignals += stats.defectSignals;
      }
    }
  }

  const totalCost = costs.reduce((sum, entry) => sum + (entry.cost ?? 0), 0);
  const retryCost = costs.reduce(
    (sum, entry) => sum + (entry.retryCause || entry.failoverReason ? (entry.cost ?? 0) : 0),
    0,
  );
  const phaseCosts: Record<string, number> = {};
  for (const entry of costs) {
    const phase = phaseOfCostEntry(entry);
    if (!phase) continue;
    phaseCosts[phase] = (phaseCosts[phase] ?? 0) + (entry.cost ?? 0);
  }
  const totalRetries = retriesByCause.checker + retriesByCause.failover + retriesByCause.timeout + retriesByCause.other;
  const sortedCycleTimes = [...cycleTimes].sort((a, b) => a - b);

  const observedPhases = [...phaseSamples.keys()];
  const orderedPhases = [
    ...PHASE_ORDER.filter((phase) => phaseSamples.has(phase)),
    ...observedPhases.filter((phase) => !PHASE_ORDER.includes(phase)).sort(),
  ];
  const phaseDurations: Record<string, number> = {};
  for (const phase of orderedPhases) {
    phaseDurations[phase] = percentile(phaseSamples.get(phase)!, 0.5)!;
  }

  return {
    runs,
    merged,
    reworkRuns,
    collisionReworkRuns,
    stuckRuns,
    mergeRate: runs === 0 ? 0 : merged / runs,
    reworkRate: runs === 0 ? 0 : reworkRuns / runs,
    collisionReworkRate: runs === 0 ? 0 : collisionReworkRuns / runs,
    stuckRate: runs === 0 ? 0 : stuckRuns / runs,
    humanInterventionRate: runs === 0 ? 0 : humanTouchedRuns / runs,
    humanTouchedRuns,
    fullyAutonomousRuns,
    humanEventsPerRun: runs === 0 ? null : totalHumanEvents / runs,
    fullyAutonomousRate: runs === 0 ? 0 : fullyAutonomousRuns / runs,
    totalCost,
    costPerMergedPr: merged === 0 ? null : totalCost / merged,
    medianCycleTimeMs: percentileFromSorted(sortedCycleTimes, 0.5),
    p90CycleTimeMs: percentileFromSorted(sortedCycleTimes, 0.9),
    phaseDurations,
    phaseCosts,
    queueWaitMs: percentile(queueWaits, 0.5),
    cycleTimeExcludedRuns: runs - cycleTimes.length,
    totalRetries,
    retriesPerRun: runs === 0 ? null : percentile(perRunRetryCounts, 0.5),
    retriesByCause,
    retryCostShare: totalCost === 0 ? 0 : retryCost / totalCost,
    readinessScoredRuns: readinessScores.length,
    meanReadinessScore: mean(readinessScores),
    readinessSplit:
      readinessScores.length === 0
        ? null
        : {
            ready: {
              runs: readyRetries.length,
              meanRetries: mean(readyRetries),
              medianCycleTimeMs: percentile(readyCycleTimes, 0.5),
            },
            notReady: {
              runs: notReadyRetries.length,
              meanRetries: mean(notReadyRetries),
              medianCycleTimeMs: percentile(notReadyCycleTimes, 0.5),
            },
          },
    sizeScoredRuns: sizeScores.length,
    sizeGateEscalatedRuns,
    sizeGateEscalationRate: runs === 0 ? 0 : sizeGateEscalatedRuns / runs,
    meanSizeScore: mean(sizeScores),
    defectWindowClosedRuns,
    postMergeDefectRuns,
    postMergeDefectSignals,
    postMergeDefectRate: defectWindowClosedRuns === 0 ? null : postMergeDefectRuns / defectWindowClosedRuns,
  };
}

function formatPercent(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

function formatCost(value: number): string {
  return `$${value.toFixed(4)}`;
}

export function formatKpiLines(kpis: HealthKpis): string[] {
  if (kpis.runs === 0) return ['No factory runs recorded yet.'];

  const lines = [
    `Runs: ${kpis.runs}`,
    `Merge rate: ${formatPercent(kpis.mergeRate)} (${kpis.merged}/${kpis.runs})`,
    `Rework rate: ${formatPercent(kpis.reworkRate)} (${kpis.reworkRuns}/${kpis.runs})`,
    `Collision-caused rework rate: ${formatPercent(kpis.collisionReworkRate)} (${kpis.collisionReworkRuns}/${kpis.runs})`,
    `Stuck rate: ${formatPercent(kpis.stuckRate)} (${kpis.stuckRuns}/${kpis.runs})`,
    `Human-touched runs: ${formatPercent(kpis.humanInterventionRate)} (${kpis.humanTouchedRuns}/${kpis.runs}, ${kpis.humanEventsPerRun === null ? 'n/a' : kpis.humanEventsPerRun.toFixed(2)} human events/run)`,
    `Fully autonomous: ${formatPercent(kpis.fullyAutonomousRate)} (${kpis.fullyAutonomousRuns}/${kpis.runs} merged with zero human events)`,
    `Retries: total ${kpis.totalRetries}, median ${kpis.retriesPerRun}/run (checker ${kpis.retriesByCause.checker} · failover ${kpis.retriesByCause.failover} · timeout ${kpis.retriesByCause.timeout} · other ${kpis.retriesByCause.other})`,
    `Retry cost share: ${formatPercent(kpis.retryCostShare)} of total spend`,
    `Cost per merged PR: ${kpis.costPerMergedPr === null ? 'n/a' : formatCost(kpis.costPerMergedPr)}`,
  ];

  lines.push(
    kpis.medianCycleTimeMs === null
      ? `Cycle time (issue→merge): n/a (${kpis.cycleTimeExcludedRuns} excluded: no terminal event)`
      : `Cycle time (issue→merge): median ${formatDurationMs(kpis.medianCycleTimeMs)}, p90 ${formatDurationMs(kpis.p90CycleTimeMs!)} (${kpis.merged} merged, ${kpis.cycleTimeExcludedRuns} excluded: no terminal event)`,
  );
  const phaseEntries = Object.entries(kpis.phaseDurations);
  if (phaseEntries.length > 0) {
    lines.push(`Phase medians: ${phaseEntries.map(([p, ms]) => `${p} ${formatDurationMs(ms)}`).join(' · ')}`);
  }
  lines.push(`Queue wait (median): ${kpis.queueWaitMs === null ? 'n/a' : formatDurationMs(kpis.queueWaitMs)}`);

  if (kpis.readinessScoredRuns > 0 && kpis.readinessSplit) {
    const { ready, notReady } = kpis.readinessSplit;
    lines.push(
      `Issue readiness: mean ${formatPercent(kpis.meanReadinessScore ?? 0)} (${kpis.readinessScoredRuns}/${kpis.runs} runs scored)`,
    );
    const describeCohort = (cohort: { runs: number; meanRetries: number | null; medianCycleTimeMs: number | null }) =>
      `${cohort.runs} run${cohort.runs === 1 ? '' : 's'} (${cohort.meanRetries === null ? 'n/a' : cohort.meanRetries.toFixed(1)} retries/run, cycle p50 ${cohort.medianCycleTimeMs === null ? 'n/a' : formatDurationMs(cohort.medianCycleTimeMs)})`;
    lines.push(`Readiness vs outcomes: ready ${describeCohort(ready)} · not-ready ${describeCohort(notReady)}`);
  }

  if (kpis.sizeScoredRuns > 0) {
    lines.push(
      `Size gate: escalated ${formatPercent(kpis.sizeGateEscalationRate)} (${kpis.sizeGateEscalatedRuns}/${kpis.runs}) · mean size score ${formatPercent(kpis.meanSizeScore ?? 0)} (${kpis.sizeScoredRuns}/${kpis.runs} runs size-scored)`,
    );
  }

  if (kpis.defectWindowClosedRuns > 0) {
    lines.push(
      `Post-merge defects: ${formatPercent(kpis.postMergeDefectRate ?? 0)} (${kpis.postMergeDefectRuns}/${kpis.defectWindowClosedRuns} runs with a closed defect window, ${kpis.postMergeDefectSignals} signal${kpis.postMergeDefectSignals === 1 ? '' : 's'})`,
    );
  }

  return lines;
}

export function renderKpiReport(kpis: HealthKpis): string {
  const lines = ['## Health KPIs', '', ...formatKpiLines(kpis).map((line) => `- ${line}`)];
  return `${lines.join('\n')}\n`;
}

export interface KpiHistoryRecord {
  date: string;
  runs: number;
  mergeRate: number;
  reworkRate: number;
  /** Share of runs whose rework was tagged merge-conflict at snapshot time (#615).
   *  Absent in legacy rows. */
  collisionReworkRate?: number;
  stuckRate: number;
  humanInterventionRate: number;
  fullyAutonomousRate: number;
  costPerMergedPr: number | null;
  medianCycleTimeMs: number | null;
  p90CycleTimeMs: number | null;
  /** HEAD commit SHA at snapshot time; null when the git lookup failed. Absent in legacy rows. */
  commitSha?: string | null;
  /** Resolved tier → ranked model list at snapshot time. Absent in legacy rows. */
  models?: Record<string, string[]>;
  /** Mean issue readiness score at snapshot time; null when no runs were scored. Absent in legacy rows. */
  meanReadinessScore?: number | null;
  /** Share of runs the INVEST size gate flagged as too big at snapshot time (#608).
   *  Absent in legacy rows. */
  sizeGateEscalationRate?: number;
  /** Mean size score at snapshot time; null when no run carried a size verdict (#608).
   *  Absent in legacy rows. */
  meanSizeScore?: number | null;
  /** Post-merge defect rate at snapshot time; null when no run's window had closed (#612).
   *  Absent in legacy rows. */
  postMergeDefectRate?: number | null;
  /** Denominator behind postMergeDefectRate at snapshot time (#612). Absent in legacy rows. */
  defectWindowClosedRuns?: number;
  /** Per-phase (plan/build/check/ship) duration medians at snapshot time, ms (#614).
   *  Absent in legacy rows. */
  phaseDurationsMs?: Record<string, number>;
  /** Per-phase model-call cost at snapshot time (#614). Only phases with at least
   *  one matching cost row are present. Absent in legacy rows. */
  phaseCosts?: Record<string, number>;
  /** Retry counts by cause (checker/failover/timeout/other) at snapshot time (#614).
   *  Absent in legacy rows. */
  retriesByCause?: Record<RetryCause, number>;
}

export function kpisToHistoryRecord(
  kpis: HealthKpis,
  date: string,
  meta: { commitSha?: string | null; models?: Record<string, string[]> } = {},
): KpiHistoryRecord {
  return {
    date,
    runs: kpis.runs,
    mergeRate: kpis.mergeRate,
    reworkRate: kpis.reworkRate,
    collisionReworkRate: kpis.collisionReworkRate,
    stuckRate: kpis.stuckRate,
    humanInterventionRate: kpis.humanInterventionRate,
    fullyAutonomousRate: kpis.fullyAutonomousRate,
    costPerMergedPr: kpis.costPerMergedPr,
    medianCycleTimeMs: kpis.medianCycleTimeMs,
    p90CycleTimeMs: kpis.p90CycleTimeMs,
    sizeGateEscalationRate: kpis.sizeGateEscalationRate,
    meanSizeScore: kpis.meanSizeScore,
    postMergeDefectRate: kpis.postMergeDefectRate,
    defectWindowClosedRuns: kpis.defectWindowClosedRuns,
    phaseDurationsMs: kpis.phaseDurations,
    phaseCosts: kpis.phaseCosts,
    retriesByCause: kpis.retriesByCause,
    ...(meta.commitSha !== undefined ? { commitSha: meta.commitSha } : {}),
    ...(meta.models !== undefined ? { models: meta.models } : {}),
    ...(kpis.meanReadinessScore !== undefined ? { meanReadinessScore: kpis.meanReadinessScore } : {}),
  };
}

export function parseKpiHistory(jsonl: string): KpiHistoryRecord[] {
  return jsonl
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as KpiHistoryRecord);
}

export function appendKpiHistoryLine(existing: string, record: KpiHistoryRecord): string {
  const line = `${JSON.stringify(record)}\n`;
  if (!existing.trim()) return line;
  return `${existing.endsWith('\n') ? existing : `${existing}\n`}${line}`;
}

/** Rolling-window size for drift detection: last N snapshots vs the preceding N (#613). */
export const KPI_DRIFT_WINDOW_SIZE = 20;
/** Drift threshold: a metric drifts when the recent window is worse than the baseline
 *  window by more than this ratio. Named/exported so it can be tuned without touching
 *  the detection logic (#613). */
export const KPI_DRIFT_THRESHOLD_RATIO = 0.25;

export interface KpiDriftMetricResult {
  baseline: number | null;
  recent: number | null;
  /** (recent - baseline) / baseline; null when a ratio cannot be computed. */
  deltaRatio: number | null;
  drift: boolean;
}

export interface KpiDriftReport {
  /** False when history has fewer than 2 * windowSize snapshots — too little data
   *  to fill both windows, so no metric can be evaluated. */
  ready: boolean;
  windowSize: number;
  thresholdRatio: number;
  reworkRate: KpiDriftMetricResult;
  costPerMergedPr: KpiDriftMetricResult;
  medianCycleTimeMs: KpiDriftMetricResult;
  /** True when any of the three metrics above drifted. Detection only — no
   *  remediation is triggered by this flag (#613). */
  drift: boolean;
}

function numericValues(values: (number | null | undefined)[]): number[] {
  return values.filter((v): v is number => typeof v === 'number');
}

function driftMetric(baselineValues: number[], recentValues: number[], thresholdRatio: number): KpiDriftMetricResult {
  const baseline = mean(baselineValues);
  const recent = mean(recentValues);
  if (baseline === null || recent === null) {
    return { baseline, recent, deltaRatio: null, drift: false };
  }
  if (baseline === 0) {
    return { baseline, recent, deltaRatio: recent === 0 ? 0 : null, drift: recent > 0 };
  }
  const deltaRatio = (recent - baseline) / baseline;
  return { baseline, recent, deltaRatio, drift: deltaRatio > thresholdRatio };
}

/** Compares the last `windowSize` KPI history snapshots against the `windowSize`
 *  preceding them, for reworkRate, costPerMergedPr, and medianCycleTimeMs — surfacing
 *  a `drift` flag when any metric got worse by more than `thresholdRatio` (#613).
 *  Detection only: this never triggers remediation, it only reports. */
export function computeKpiDrift(
  records: KpiHistoryRecord[],
  opts: { windowSize?: number; thresholdRatio?: number } = {},
): KpiDriftReport {
  const windowSize = opts.windowSize ?? KPI_DRIFT_WINDOW_SIZE;
  const thresholdRatio = opts.thresholdRatio ?? KPI_DRIFT_THRESHOLD_RATIO;
  const notReady: KpiDriftMetricResult = { baseline: null, recent: null, deltaRatio: null, drift: false };

  if (records.length < windowSize * 2) {
    return {
      ready: false,
      windowSize,
      thresholdRatio,
      reworkRate: notReady,
      costPerMergedPr: notReady,
      medianCycleTimeMs: notReady,
      drift: false,
    };
  }

  const recentWindow = records.slice(records.length - windowSize);
  const baselineWindow = records.slice(records.length - windowSize * 2, records.length - windowSize);

  const reworkRate = driftMetric(
    numericValues(baselineWindow.map((r) => r.reworkRate)),
    numericValues(recentWindow.map((r) => r.reworkRate)),
    thresholdRatio,
  );
  const costPerMergedPr = driftMetric(
    numericValues(baselineWindow.map((r) => r.costPerMergedPr)),
    numericValues(recentWindow.map((r) => r.costPerMergedPr)),
    thresholdRatio,
  );
  const medianCycleTimeMs = driftMetric(
    numericValues(baselineWindow.map((r) => r.medianCycleTimeMs)),
    numericValues(recentWindow.map((r) => r.medianCycleTimeMs)),
    thresholdRatio,
  );

  return {
    ready: true,
    windowSize,
    thresholdRatio,
    reworkRate,
    costPerMergedPr,
    medianCycleTimeMs,
    drift: reworkRate.drift || costPerMergedPr.drift || medianCycleTimeMs.drift,
  };
}

function formatDriftDelta(metric: KpiDriftMetricResult): string {
  if (metric.deltaRatio === null) return 'n/a';
  const pct = Math.round(metric.deltaRatio * 100);
  return `${pct > 0 ? '+' : ''}${pct}%`;
}

function formatDriftMetricLine(
  label: string,
  metric: KpiDriftMetricResult,
  formatValue: (v: number) => string,
): string {
  if (metric.baseline === null || metric.recent === null) return `${label} n/a`;
  const marker = metric.drift ? ' ⚠' : '';
  return `${label} ${formatDriftDelta(metric)} (baseline ${formatValue(metric.baseline)} → recent ${formatValue(metric.recent)})${marker}`;
}

export function renderKpiDriftLine(report: KpiDriftReport): string {
  if (!report.ready) {
    return `Drift: not enough history yet (need ${report.windowSize * 2} snapshots for a rolling ${report.windowSize}-vs-${report.windowSize} window).`;
  }
  const headline = report.drift
    ? `⚠ Drift detected (rolling ${report.windowSize}-vs-${report.windowSize}, threshold +${Math.round(report.thresholdRatio * 100)}%)`
    : `No drift (rolling ${report.windowSize}-vs-${report.windowSize}, threshold +${Math.round(report.thresholdRatio * 100)}%)`;
  const parts = [
    formatDriftMetricLine('rework rate', report.reworkRate, formatPercent),
    formatDriftMetricLine('cost/merged PR', report.costPerMergedPr, formatCost),
    formatDriftMetricLine('cycle time p50', report.medianCycleTimeMs, formatDurationMs),
  ];
  return `${headline}: ${parts.join(' · ')}`;
}

function formatSignedPp(curr: number | undefined, prev: number | undefined): string {
  if (typeof curr !== 'number' || typeof prev !== 'number') return '—';
  const delta = Math.round((curr - prev) * 100);
  if (delta === 0) return '0pp';
  return `${delta > 0 ? '+' : '−'}${Math.abs(delta)}pp`;
}

function formatSignedInt(curr: number, prev: number): string {
  const delta = curr - prev;
  if (delta === 0) return '0';
  return `${delta > 0 ? '+' : '−'}${Math.abs(delta)}`;
}

function formatSignedCost(curr: number | null, prev: number | null): string {
  if (curr === null || prev === null) return '—';
  const delta = curr - prev;
  if (delta === 0) return formatCost(0);
  return `${delta > 0 ? '+' : '−'}${formatCost(Math.abs(delta))}`;
}

function formatSignedDuration(curr: number | null | undefined, prev: number | null | undefined): string {
  if (typeof curr !== 'number' || typeof prev !== 'number') return '—';
  const delta = curr - prev;
  if (delta === 0) return '0s';
  return `${delta > 0 ? '+' : '−'}${formatDurationMs(Math.abs(delta))}`;
}

function renderKpiDeltaLine(prev: KpiHistoryRecord, curr: KpiHistoryRecord): string {
  const parts = [
    `runs ${formatSignedInt(curr.runs, prev.runs)}`,
    `merge ${formatSignedPp(curr.mergeRate, prev.mergeRate)}`,
    `rework ${formatSignedPp(curr.reworkRate, prev.reworkRate)}`,
    `stuck ${formatSignedPp(curr.stuckRate, prev.stuckRate)}`,
    `human ${formatSignedPp(curr.humanInterventionRate, prev.humanInterventionRate)}`,
    `auto ${formatSignedPp(curr.fullyAutonomousRate, prev.fullyAutonomousRate)}`,
    `$/merged ${formatSignedCost(curr.costPerMergedPr, prev.costPerMergedPr)}`,
    `cycle p50 ${formatSignedDuration(curr.medianCycleTimeMs, prev.medianCycleTimeMs)}`,
    `cycle p90 ${formatSignedDuration(curr.p90CycleTimeMs, prev.p90CycleTimeMs)}`,
  ];
  return `Δ vs previous: ${parts.join(' · ')}`;
}

export function renderKpiTrend(records: KpiHistoryRecord[], opts: { window?: number } = {}): string {
  const window = opts.window ?? 14;
  const lines = ['## Health KPI trend', ''];

  if (records.length === 0) {
    lines.push('No KPI history yet.');
    return `${lines.join('\n')}\n`;
  }

  const visible = records.slice(-window);
  lines.push(
    '| date | runs | merge | rework | stuck | human | auto | $/merged | cycle p50 | cycle p90 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...visible.map((record) => {
      const columns = [
        record.date,
        String(record.runs),
        formatPercent(record.mergeRate),
        formatPercent(record.reworkRate),
        formatPercent(record.stuckRate),
        formatPercent(record.humanInterventionRate),
        typeof record.fullyAutonomousRate === 'number' ? formatPercent(record.fullyAutonomousRate) : '—',
        record.costPerMergedPr === null ? '—' : formatCost(record.costPerMergedPr),
        typeof record.medianCycleTimeMs === 'number' ? formatDurationMs(record.medianCycleTimeMs) : '—',
        typeof record.p90CycleTimeMs === 'number' ? formatDurationMs(record.p90CycleTimeMs) : '—',
      ];
      return `| ${columns.join(' | ')} |`;
    }),
  );

  if (records.length >= 2) {
    const prev = records[records.length - 2];
    const curr = records[records.length - 1];
    lines.push('', renderKpiDeltaLine(prev, curr));
  }

  const drift = computeKpiDrift(records);
  if (drift.ready) {
    lines.push('', renderKpiDriftLine(drift));
  }

  return `${lines.join('\n')}\n`;
}
