// packages/scbench-adapter/src/compare.ts — regression comparison between two retained measured SCBench runs (#1135).
import {
  evaluateAllGroupsVerdict,
  evaluateTrialVerdict,
  groupCounts,
  REPORT_GROUPS,
  type BaselineTrial,
} from './baseline.js';

/** Fail-closed per-side tally for one problem/checkpoint group. Missing
 *  evidence and infrastructure failures stay in `total` and never count
 *  as passes (ADR-0007). */
export interface ComparisonSideStats {
  passes: number;
  fails: number;
  infrastructureFailures: number;
  missingEvidence: number;
  total: number;
}

type ReportGroup = (typeof REPORT_GROUPS)[number];

/** Summed pass/total for one test group (or, for allGroups, passing trials / recorded trials). Report-only. */
export interface GroupRate {
  passed: number;
  total: number;
}

export type PerGroupRates = Record<ReportGroup, GroupRate> & { allGroups: GroupRate };

export type ComparisonStatus = 'regression' | 'no-change' | 'improvement' | 'baseline-only' | 'candidate-only';

interface ComparisonEntryBase {
  /** Problem/checkpoint group key: the trial id's parent path, e.g. "cfgpipe/checkpoint_1" or "smoke". */
  key: string;
}

/** Both sides recorded trials for this group — comparable, always carries baseline, candidate, and the delta. */
export interface ComparableComparisonEntry extends ComparisonEntryBase {
  status: 'regression' | 'no-change' | 'improvement';
  baseline: ComparisonSideStats;
  candidate: ComparisonSideStats;
  /** Report-only per-test-group rates; never feed the gate. */
  baselineGroups: PerGroupRates;
  candidateGroups: PerGroupRates;
  /** candidate rate − baseline rate, in percentage points. */
  deltaPoints: number;
}

/** Only the baseline run recorded trials for this group — not comparable. */
export interface BaselineOnlyComparisonEntry extends ComparisonEntryBase {
  status: 'baseline-only';
  baseline: ComparisonSideStats;
  baselineGroups: PerGroupRates;
}

/** Only the candidate run recorded trials for this group — not comparable. */
export interface CandidateOnlyComparisonEntry extends ComparisonEntryBase {
  status: 'candidate-only';
  candidate: ComparisonSideStats;
  candidateGroups: PerGroupRates;
}

export type ComparisonEntry = ComparableComparisonEntry | BaselineOnlyComparisonEntry | CandidateOnlyComparisonEntry;

export interface ComparisonResult {
  entries: ComparisonEntry[];
  /** Worst measured drop across comparable groups, in percentage points; 0 when none regressed. */
  maxRegressionPoints: number;
  thresholdPoints: number;
  /** true iff maxRegressionPoints > thresholdPoints (strict). */
  exceedsThreshold: boolean;
}

/** The problem/checkpoint group a trial belongs to — its id's parent path
 *  (e.g. "cfgpipe/checkpoint_1"), falling back to the full id when it has
 *  no "/" (e.g. a flat "smoke" trial). */
function groupKey(trial: BaselineTrial): string {
  const idx = trial.id.lastIndexOf('/');
  return idx === -1 ? trial.id : trial.id.slice(0, idx);
}

function emptyStats(): ComparisonSideStats {
  return { passes: 0, fails: 0, infrastructureFailures: 0, missingEvidence: 0, total: 0 };
}

/** Bucket trials by groupKey, classifying each with evaluateTrialVerdict —
 *  the sole source of correctness, reused unchanged so missing evidence or
 *  an infrastructure failure can never count as a pass (ADR-0007). */
function tally(trials: BaselineTrial[]): Map<string, ComparisonSideStats> {
  const groups = new Map<string, ComparisonSideStats>();
  for (const trial of trials) {
    const key = groupKey(trial);
    const stats = groups.get(key) ?? emptyStats();
    const verdict = evaluateTrialVerdict(trial);
    if (verdict === 'pass') stats.passes += 1;
    else if (verdict === 'fail') stats.fails += 1;
    else if (verdict === 'infrastructure-failure') stats.infrastructureFailures += 1;
    else stats.missingEvidence += 1;
    stats.total += 1;
    groups.set(key, stats);
  }
  return groups;
}

function bucketByKey(trials: BaselineTrial[]): Map<string, BaselineTrial[]> {
  const buckets = new Map<string, BaselineTrial[]>();
  for (const trial of trials) {
    const key = groupKey(trial);
    const bucket = buckets.get(key) ?? [];
    bucket.push(trial);
    buckets.set(key, bucket);
  }
  return buckets;
}

/** Per test group, the largest total seen on any evidenced, non-infrastructure-failure trial —
 *  what a trial with no usable evidence is charged so it stays in the denominator. */
function referenceTotals(trials: BaselineTrial[]): Record<ReportGroup, number> {
  const totals: Record<ReportGroup, number> = { Core: 0, Functionality: 0, Regression: 0, Error: 0 };
  for (const trial of trials) {
    const evaluation = trial.evidence.evaluation;
    if (!evaluation || evaluation.infrastructure_failure) continue;
    for (const group of REPORT_GROUPS) {
      totals[group] = Math.max(totals[group], groupCounts(evaluation, group).total);
    }
  }
  return totals;
}

/** Report-only per-group tally: summed passes/totals per test group, with unusable trials charged
 *  zero passes and the reference total (fail-closed, ADR-0007). allGroups counts trials. */
function tallyGroupRates(trials: BaselineTrial[], reference: Record<ReportGroup, number>): PerGroupRates {
  const rates: PerGroupRates = {
    Core: { passed: 0, total: 0 },
    Functionality: { passed: 0, total: 0 },
    Regression: { passed: 0, total: 0 },
    Error: { passed: 0, total: 0 },
    allGroups: { passed: 0, total: 0 },
  };
  for (const trial of trials) {
    const verdict = evaluateTrialVerdict(trial);
    const evaluation = trial.evidence.evaluation;
    for (const group of REPORT_GROUPS) {
      if (verdict === 'missing-evidence' || verdict === 'infrastructure-failure' || !evaluation) {
        rates[group].total += reference[group];
      } else {
        const counts = groupCounts(evaluation, group);
        rates[group].passed += counts.passed;
        rates[group].total += counts.total;
      }
    }
    rates.allGroups.total += 1;
    if (evaluateAllGroupsVerdict(trial) === 'pass') rates.allGroups.passed += 1;
  }
  return rates;
}

/** A group always has total >= 1 by construction (tally only creates an
 *  entry when it sees a trial), so this never divides by zero. */
function passRate(stats: ComparisonSideStats): number {
  return stats.passes / stats.total;
}

/** Narrows a possibly-absent map lookup, failing loudly rather than
 *  silently asserting non-null if an invariant is ever violated. */
function expectDefined(value: ComparisonSideStats | undefined, key: string, side: string): ComparisonSideStats {
  if (value === undefined) {
    throw new Error(`compareTrialSets: invariant violated — group "${key}" missing from ${side} stats`);
  }
  return value;
}

/** Compares two retained measured SCBench runs directories' trials
 *  group-by-group (by problem/checkpoint), deriving correctness exclusively
 *  from validated native evidence via evaluateTrialVerdict. The exit-code
 *  gate (exceedsThreshold) considers only measured regressions — groups
 *  present on only one side are reported but never trip it. */
export function compareTrialSets(
  baseline: BaselineTrial[],
  candidate: BaselineTrial[],
  thresholdPoints: number,
): ComparisonResult {
  const baselineStats = tally(baseline);
  const candidateStats = tally(candidate);
  const baselineTrials = bucketByKey(baseline);
  const candidateTrials = bucketByKey(candidate);
  const keys = [...new Set([...baselineStats.keys(), ...candidateStats.keys()])].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );

  const entries: ComparisonEntry[] = keys.map((key) => {
    const base = baselineStats.get(key);
    const cand = candidateStats.get(key);
    const baseTrials = baselineTrials.get(key) ?? [];
    const candTrials = candidateTrials.get(key) ?? [];
    if (base === undefined) {
      return {
        key,
        candidate: expectDefined(cand, key, 'candidate'),
        candidateGroups: tallyGroupRates(candTrials, referenceTotals(candTrials)),
        status: 'candidate-only',
      };
    }
    if (cand === undefined) {
      return {
        key,
        baseline: base,
        baselineGroups: tallyGroupRates(baseTrials, referenceTotals(baseTrials)),
        status: 'baseline-only',
      };
    }
    const reference = referenceTotals([...baseTrials, ...candTrials]);
    const deltaPoints = (passRate(cand) - passRate(base)) * 100;
    const status: ComparableComparisonEntry['status'] =
      deltaPoints < 0 ? 'regression' : deltaPoints > 0 ? 'improvement' : 'no-change';
    return {
      key,
      baseline: base,
      candidate: cand,
      baselineGroups: tallyGroupRates(baseTrials, reference),
      candidateGroups: tallyGroupRates(candTrials, reference),
      deltaPoints,
      status,
    };
  });

  const regressionDrops = entries
    .filter((e): e is ComparableComparisonEntry & { status: 'regression' } => e.status === 'regression')
    .map((e) => -e.deltaPoints);
  const maxRegressionPoints = regressionDrops.length > 0 ? Math.max(...regressionDrops) : 0;

  return {
    entries,
    maxRegressionPoints,
    thresholdPoints,
    exceedsThreshold: maxRegressionPoints > thresholdPoints,
  };
}

function formatRate(stats: ComparisonSideStats): string {
  return `${((stats.passes / stats.total) * 100).toFixed(1)}%`;
}

function formatSideDetail(stats: ComparisonSideStats): string {
  const parts = [`${stats.passes} pass / ${stats.total} trial${stats.total === 1 ? '' : 's'}`];
  if (stats.missingEvidence > 0) parts.push(`${stats.missingEvidence} missing evidence`);
  if (stats.infrastructureFailures > 0) {
    parts.push(
      `${stats.infrastructureFailures} infrastructure failure${stats.infrastructureFailures === 1 ? '' : 's'}`,
    );
  }
  return parts.join(', ');
}

function formatGroupPercent(rate: GroupRate): string {
  return rate.total === 0 ? 'none' : `${((rate.passed / rate.total) * 100).toFixed(1)}%`;
}

function formatGroupDelta(base: GroupRate, cand: GroupRate): string {
  if (base.total === 0 || cand.total === 0) return 'delta n/a';
  const delta = (cand.passed / cand.total - base.passed / base.total) * 100;
  const text = delta.toFixed(1);
  if (text === '0.0' || text === '-0.0') return 'delta 0.0 points';
  return `delta ${delta > 0 ? '+' : ''}${text} points`;
}

/** Report-only per-group lines (Core, Functionality, Regression, Error, All groups). Never gate. */
function renderGroupRateLines(base: PerGroupRates | undefined, cand: PerGroupRates | undefined): string[] {
  const rows: Array<{ label: string; key: ReportGroup | 'allGroups'; unit: string }> = [
    ...REPORT_GROUPS.map((group) => ({ label: group, key: group, unit: 'tests' })),
    { label: 'All groups', key: 'allGroups', unit: 'trials' },
  ];
  return rows.map(({ label, key, unit }) => {
    const b = base?.[key];
    const c = cand?.[key];
    if (b !== undefined && c !== undefined) {
      if (b.total === 0 && c.total === 0) return `  - ${label}: none (report-only)`;
      return `  - ${label}: ${formatGroupPercent(b)} → ${formatGroupPercent(c)} (report-only; ${formatGroupDelta(b, c)}; ${b.passed}/${b.total} → ${c.passed}/${c.total} ${unit})`;
    }
    const side = b ?? c;
    if (side === undefined || side.total === 0) return `  - ${label}: none (report-only)`;
    return `  - ${label}: ${side.passed}/${side.total} (${formatGroupPercent(side)}) (report-only)`;
  });
}

function renderEntry(entry: ComparisonEntry): string {
  return renderEntryLines(entry).join('\n');
}

function renderEntryLines(entry: ComparisonEntry): string[] {
  if (entry.status === 'baseline-only') {
    return [
      `- ${entry.key}: not comparable — present only in the baseline run (candidate recorded no trials for this problem/checkpoint; absence is reported, never scored)`,
      ...renderGroupRateLines(entry.baselineGroups, undefined),
    ];
  }
  if (entry.status === 'candidate-only') {
    return [
      `- ${entry.key}: new in candidate — no baseline to compare against`,
      ...renderGroupRateLines(undefined, entry.candidateGroups),
    ];
  }
  return [renderComparableHead(entry), ...renderGroupRateLines(entry.baselineGroups, entry.candidateGroups)];
}

function renderComparableHead(entry: ComparableComparisonEntry): string {
  const { baseline, candidate, deltaPoints: delta } = entry;
  const detail = `baseline ${formatSideDetail(baseline)}; candidate ${formatSideDetail(candidate)}`;

  if (entry.status === 'regression') {
    return `- ${entry.key}: REGRESSION — core-cases pass rate ${formatRate(baseline)} → ${formatRate(candidate)} (drop ${(-delta).toFixed(1)} points; ${detail})`;
  }
  if (entry.status === 'improvement') {
    return `- ${entry.key}: improvement — core-cases pass rate ${formatRate(baseline)} → ${formatRate(candidate)} (gain ${delta.toFixed(1)} points; ${detail})`;
  }
  return `- ${entry.key}: no change — core-cases pass rate ${formatRate(baseline)} → ${formatRate(candidate)} (${detail})`;
}

function renderVerdict(result: ComparisonResult): string {
  if (result.exceedsThreshold) {
    return `Verdict: REGRESSION — worst core-cases pass-rate drop ${result.maxRegressionPoints.toFixed(1)} points exceeds threshold ${result.thresholdPoints} points.`;
  }
  if (result.maxRegressionPoints > 0) {
    return `Verdict: OK — worst core-cases pass-rate drop ${result.maxRegressionPoints.toFixed(1)} points is within threshold ${result.thresholdPoints} points.`;
  }
  return 'Verdict: OK — no measured core-cases regression.';
}

/** Pure string builder — operator-readable, mirroring the tone of
 *  generateBaselineReport. Every value is derived from `result`. */
export function renderComparisonReport(result: ComparisonResult): string {
  const header = '# SCBench regression comparison';
  const passPolicyLine =
    'Pass policy: core-cases — per problem/checkpoint, pass rate = trials passing all Core-group tests / recorded trials. A trial with missing native evaluation evidence or an infrastructure failure never counts as a pass (ADR-0007).';
  const perGroupLine =
    "Per-group lines (report-only): summed pass/total per test group across a group's trials; All groups = trials passing every test group / recorded trials. Missing evidence and infrastructure failures stay in every denominator and never count as a pass. These lines never affect the verdict or the exit code.";
  const body =
    result.entries.length === 0
      ? 'No comparable trials recorded on either side.'
      : result.entries.map(renderEntry).join('\n');

  return `${[header, passPolicyLine, perGroupLine, body, renderVerdict(result)].join('\n\n')}\n`;
}
