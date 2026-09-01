// packages/scbench-adapter/src/compare.ts — regression comparison between two retained measured SCBench runs (#1135).
import { evaluateTrialVerdict, type BaselineTrial } from './baseline.js';

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
  /** candidate rate − baseline rate, in percentage points. */
  deltaPoints: number;
}

/** Only the baseline run recorded trials for this group — not comparable. */
export interface BaselineOnlyComparisonEntry extends ComparisonEntryBase {
  status: 'baseline-only';
  baseline: ComparisonSideStats;
}

/** Only the candidate run recorded trials for this group — not comparable. */
export interface CandidateOnlyComparisonEntry extends ComparisonEntryBase {
  status: 'candidate-only';
  candidate: ComparisonSideStats;
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
  const keys = [...new Set([...baselineStats.keys(), ...candidateStats.keys()])].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );

  const entries: ComparisonEntry[] = keys.map((key) => {
    const base = baselineStats.get(key);
    const cand = candidateStats.get(key);
    if (base === undefined) {
      return { key, candidate: expectDefined(cand, key, 'candidate'), status: 'candidate-only' };
    }
    if (cand === undefined) {
      return { key, baseline: base, status: 'baseline-only' };
    }
    const deltaPoints = (passRate(cand) - passRate(base)) * 100;
    const status: ComparableComparisonEntry['status'] =
      deltaPoints < 0 ? 'regression' : deltaPoints > 0 ? 'improvement' : 'no-change';
    return { key, baseline: base, candidate: cand, deltaPoints, status };
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

function renderEntry(entry: ComparisonEntry): string {
  if (entry.status === 'baseline-only') {
    return `- ${entry.key}: not comparable — present only in the baseline run (candidate recorded no trials for this problem/checkpoint; absence is reported, never scored)`;
  }
  if (entry.status === 'candidate-only') {
    return `- ${entry.key}: new in candidate — no baseline to compare against`;
  }

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
  const body =
    result.entries.length === 0
      ? 'No comparable trials recorded on either side.'
      : result.entries.map(renderEntry).join('\n');

  return `${[header, passPolicyLine, body, renderVerdict(result)].join('\n\n')}\n`;
}
