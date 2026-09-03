// src/reports/sandbox-ab.ts — A/B cohort comparison of docker-sandbox vs baseline
// runtimes over the cost log + event log (#656), turning #655's per-cost-row
// instrumentation into a go/no-go recommendation.

import type { CostEntry, FactoryEvent } from '../types/index.js';

export const DOCKER_SANDBOX_RUNTIME = 'docker-sandbox';

// Recommendation thresholds — first-cut values for a small fixture; tuning is a
// one-line change here, not an ADR (see issue #656 openQuestions).
const CI_TOLERANCE = 0.05; // docker within 5pp of baseline CI pass rate is "not worse"
const WALL_REGRESSION_RATIO = 1.2; // docker >20% slower mean wall-clock is a regression
const REWORK_REGRESSION_DELTA = 0.5; // docker >0.5 more mean rework rounds is a regression
const MIN_COHORT_RUNS = 1; // both cohorts need at least this many runs for a verdict

export type SandboxAbRecommendation = 'flip-default' | 'keep-opt-in' | 'drop' | 'insufficient-data';

export interface SandboxAbCohortMetrics {
  /** Runs (issues) with >=1 cost row in this cohort. */
  runs: number;
  /** Mean per-run summed `duration`; null when nothing scored. */
  meanWallClockMs: number | null;
  wallClockScoredRuns: number;
  /** Mean per-run MAX `reworkRoundCount`; null when nothing scored. */
  meanReworkRounds: number | null;
  reworkScoredRuns: number;
  /** Total sandbox_violation events over cohort runs. */
  sandboxViolations: number;
  /** Total resource_limit events over cohort runs. */
  resourceLimits: number;
  /** ciPassRuns / ciVerdictRuns; null when no cohort run reached a CI verdict. */
  ciPassRate: number | null;
  ciVerdictRuns: number;
}

export interface SandboxAbReport {
  docker: SandboxAbCohortMetrics;
  baseline: SandboxAbCohortMetrics;
  /** Runs whose cost rows carry no sandboxRuntime; excluded from both cohorts. */
  unknownRuns: number;
  recommendation: SandboxAbRecommendation;
  rationale: string;
}

type Cohort = 'docker' | 'baseline' | 'unknown';

type CiVerdict = 'pass' | 'fail' | undefined;

function cohortOf(rows: CostEntry[]): Cohort {
  const resolved = rows.find((r) => r.sandboxRuntime !== undefined)?.sandboxRuntime;
  if (resolved === undefined) return 'unknown';
  return resolved === DOCKER_SANDBOX_RUNTIME ? 'docker' : 'baseline';
}

function sumDuration(rows: CostEntry[]): number | null {
  const finite = rows.map((r) => r.duration).filter((d): d is number => typeof d === 'number' && Number.isFinite(d));
  if (finite.length === 0) return null;
  return finite.reduce((sum, d) => sum + d, 0);
}

function maxRework(rows: CostEntry[]): number | null {
  const finite = rows
    .map((r) => r.reworkRoundCount)
    .filter((r): r is number => typeof r === 'number' && Number.isFinite(r));
  if (finite.length === 0) return null;
  return Math.max(...finite);
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function emptyCohortMetrics(): SandboxAbCohortMetrics {
  return {
    runs: 0,
    meanWallClockMs: null,
    wallClockScoredRuns: 0,
    meanReworkRounds: null,
    reworkScoredRuns: 0,
    sandboxViolations: 0,
    resourceLimits: 0,
    ciPassRate: null,
    ciVerdictRuns: 0,
  };
}

export function computeSandboxAbReport(events: FactoryEvent[], costs: CostEntry[]): SandboxAbReport {
  const costsByIssue = new Map<string, CostEntry[]>();
  for (const row of costs) {
    const rows = costsByIssue.get(row.issue);
    if (rows) rows.push(row);
    else costsByIssue.set(row.issue, [row]);
  }

  const cohortByIssue = new Map<string, Cohort>();
  let unknownRuns = 0;
  for (const [issue, rows] of costsByIssue) {
    const cohort = cohortOf(rows);
    cohortByIssue.set(issue, cohort);
    if (cohort === 'unknown') unknownRuns++;
  }

  const violationsByIssue = new Map<string, number>();
  const resourcesByIssue = new Map<string, number>();
  const verdictByIssue = new Map<string, CiVerdict>();
  for (const event of events) {
    if (!cohortByIssue.has(event.issue)) continue;
    if (event.type === 'sandbox_violation') {
      violationsByIssue.set(event.issue, (violationsByIssue.get(event.issue) ?? 0) + 1);
    }
    if (event.type === 'resource_limit') {
      resourcesByIssue.set(event.issue, (resourcesByIssue.get(event.issue) ?? 0) + 1);
    }
    if (event.type === 'merged' || event.type === 'human-merged') {
      verdictByIssue.set(event.issue, 'pass');
    } else if (event.type === 'ci-failed' && verdictByIssue.get(event.issue) !== 'pass') {
      verdictByIssue.set(event.issue, 'fail');
    }
  }

  const docker = emptyCohortMetrics();
  const baseline = emptyCohortMetrics();
  const wallClockValues: Record<Cohort, number[]> = { docker: [], baseline: [], unknown: [] };
  const reworkValues: Record<Cohort, number[]> = { docker: [], baseline: [], unknown: [] };

  for (const [issue, cohort] of cohortByIssue) {
    if (cohort === 'unknown') continue;
    const metrics = cohort === 'docker' ? docker : baseline;
    metrics.runs++;

    const rows = costsByIssue.get(issue)!;
    const wallClockMs = sumDuration(rows);
    if (wallClockMs !== null) wallClockValues[cohort].push(wallClockMs);
    const reworkRounds = maxRework(rows);
    if (reworkRounds !== null) reworkValues[cohort].push(reworkRounds);

    metrics.sandboxViolations += violationsByIssue.get(issue) ?? 0;
    metrics.resourceLimits += resourcesByIssue.get(issue) ?? 0;

    const verdict = verdictByIssue.get(issue);
    if (verdict === 'pass' || verdict === 'fail') metrics.ciVerdictRuns++;
  }

  for (const [cohort, metrics] of [
    ['docker', docker],
    ['baseline', baseline],
  ] as const) {
    metrics.meanWallClockMs = mean(wallClockValues[cohort]);
    metrics.wallClockScoredRuns = wallClockValues[cohort].length;
    metrics.meanReworkRounds = mean(reworkValues[cohort]);
    metrics.reworkScoredRuns = reworkValues[cohort].length;
    metrics.ciPassRate =
      metrics.ciVerdictRuns > 0
        ? [...cohortByIssue.entries()].filter(([issue, c]) => c === cohort && verdictByIssue.get(issue) === 'pass')
            .length / metrics.ciVerdictRuns
        : null;
  }

  const { recommendation, rationale } = recommendSandboxAb(docker, baseline);

  return { docker, baseline, unknownRuns, recommendation, rationale };
}

export function recommendSandboxAb(
  docker: SandboxAbCohortMetrics,
  baseline: SandboxAbCohortMetrics,
): { recommendation: SandboxAbRecommendation; rationale: string } {
  if (docker.runs < MIN_COHORT_RUNS || baseline.runs < MIN_COHORT_RUNS) {
    const empty = docker.runs < MIN_COHORT_RUNS ? 'docker' : 'baseline';
    return {
      recommendation: 'insufficient-data',
      rationale: `${empty} cohort has too few runs (need >= ${MIN_COHORT_RUNS}) for a verdict`,
    };
  }

  const ciKnown = docker.ciPassRate !== null && baseline.ciPassRate !== null;

  if (ciKnown && docker.ciPassRate! < baseline.ciPassRate! - CI_TOLERANCE) {
    return {
      recommendation: 'drop',
      rationale: `docker CI pass rate ${(docker.ciPassRate! * 100).toFixed(1)}% is more than ${(CI_TOLERANCE * 100).toFixed(0)}pp below baseline ${(baseline.ciPassRate! * 100).toFixed(1)}%`,
    };
  }

  const wallWorse =
    docker.meanWallClockMs !== null &&
    baseline.meanWallClockMs !== null &&
    docker.meanWallClockMs > baseline.meanWallClockMs * WALL_REGRESSION_RATIO;
  const reworkWorse =
    docker.meanReworkRounds !== null &&
    baseline.meanReworkRounds !== null &&
    docker.meanReworkRounds > baseline.meanReworkRounds + REWORK_REGRESSION_DELTA;
  const breakageWorse =
    (docker.sandboxViolations + docker.resourceLimits) / docker.runs >
    (baseline.sandboxViolations + baseline.resourceLimits) / baseline.runs;

  if (
    ciKnown &&
    docker.ciPassRate! >= baseline.ciPassRate! - CI_TOLERANCE &&
    !wallWorse &&
    !reworkWorse &&
    !breakageWorse
  ) {
    return {
      recommendation: 'flip-default',
      rationale: 'docker matches baseline CI pass rate with no wall-clock, rework, or violation regression',
    };
  }

  const reasons: string[] = [];
  if (!ciKnown) reasons.push('CI pass rate unknown for one cohort');
  if (wallWorse) reasons.push('wall-clock regressed');
  if (reworkWorse) reasons.push('rework rounds regressed');
  if (breakageWorse) reasons.push('sandbox violations/resource limits regressed');
  if (reasons.length === 0) reasons.push('CI pass rate not confidently better than baseline');

  return { recommendation: 'keep-opt-in', rationale: reasons.join('; ') };
}

function formatMs(ms: number | null, scoredRuns: number): string {
  if (ms === null) return `n/a (0 scored)`;
  return `${Math.round(ms)}ms (${scoredRuns} scored)`;
}

function formatRework(rounds: number | null, scoredRuns: number): string {
  if (rounds === null) return `n/a (0 scored)`;
  return `${rounds.toFixed(2)} (${scoredRuns} scored)`;
}

function formatCiPassRate(rate: number | null, verdictRuns: number): string {
  if (rate === null) return `n/a (0 verdicts)`;
  return `${(rate * 100).toFixed(1)}% (${verdictRuns} verdicts)`;
}

function renderCohort(name: string, metrics: SandboxAbCohortMetrics): string[] {
  return [
    `${name}:`,
    `  runs: ${metrics.runs}`,
    `  mean wall-clock: ${formatMs(metrics.meanWallClockMs, metrics.wallClockScoredRuns)}`,
    `  mean rework rounds: ${formatRework(metrics.meanReworkRounds, metrics.reworkScoredRuns)}`,
    `  sandbox_violation events: ${metrics.sandboxViolations}`,
    `  resource_limit events: ${metrics.resourceLimits}`,
    `  CI pass rate: ${formatCiPassRate(metrics.ciPassRate, metrics.ciVerdictRuns)}`,
  ];
}

export function renderSandboxAbReport(report: SandboxAbReport): string {
  const lines = [
    'Sandbox A/B Report',
    '',
    ...renderCohort('docker-sandbox', report.docker),
    '',
    ...renderCohort('baseline', report.baseline),
  ];
  if (report.unknownRuns > 0) {
    lines.push('', `unknown runs (no sandboxRuntime recorded): ${report.unknownRuns}`);
  }
  lines.push('', `Recommendation: ${report.recommendation.toUpperCase()} — ${report.rationale}`);
  return lines.join('\n');
}
