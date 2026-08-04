// packages/core/src/sim/monte-carlo.ts — Monte Carlo layer over the headless simulator:
// runs M independent, seed-derived batches through runSimulation and aggregates the
// shipped/parked/escalated outcomes into rates. Adds no new seam to the pipeline — every
// run reaches the fake doubles only through runSimulation, each with its own throwaway
// workspace so branches from one run can never collide with another's.

import { deriveSimSeed, type SimJitterConfig } from './jitter.js';
import { runSimulation, type SimulationOptions, type SimulationReport } from './pipeline.js';
import type { SimTerminalState } from './types.js';

export interface MonteCarloThresholds {
  /** Max tolerated (parked + escalated) / totalIssues. */
  maxFailureRate?: number;
  maxParkRate?: number;
  maxEscalationRate?: number;
}

export interface MonteCarloRates {
  shipped: number;
  parked: number;
  escalated: number;
  /** parked + escalated, over totalIssues. */
  failure: number;
}

export interface MonteCarloBreach {
  metric: 'failure' | 'parked' | 'escalated';
  rate: number;
  threshold: number;
}

export interface MonteCarloRunSummary {
  /** 0-based run index; run summaries are always ordered by it. */
  run: number;
  /** Jitter seed this run used, or null when the simulation configures no jitter. */
  seed: number | null;
  issues: number;
  totals: Record<SimTerminalState, number>;
  modelCalls: number;
  githubCalls: number;
  injectedFailures: number;
}

export interface MonteCarloReport {
  runs: number;
  totalIssues: number;
  totals: Record<SimTerminalState, number>;
  rates: MonteCarloRates;
  modelCalls: number;
  githubCalls: number;
  injectedFailures: number;
  runSummaries: MonteCarloRunSummary[];
  thresholds: MonteCarloThresholds;
  /** Empty when every configured threshold held. */
  breaches: MonteCarloBreach[];
}

export interface MonteCarloOptions {
  /** Number of simulations to run. Must be a positive integer. */
  runs: number;
  /** Per-run options. `workspace` is intentionally excluded — each run owns and disposes its own. */
  simulation: Omit<SimulationOptions, 'workspace'>;
  /** Max runs in flight. Defaults to 1 (sequential). Clamped to [1, runs]. */
  concurrency?: number;
  thresholds?: MonteCarloThresholds;
  /** Seam for tests; defaults to runSimulation. */
  simulate?: (options: SimulationOptions, run: number) => Promise<SimulationReport>;
  /** Called as each run finishes — in completion order, which under concurrency > 1 is not run order. */
  onRunComplete?: (summary: MonteCarloRunSummary) => void;
}

export function summarizeSimulationRun(
  run: number,
  seed: number | null,
  report: SimulationReport,
): MonteCarloRunSummary {
  return {
    run,
    seed,
    issues: report.outcomes.length,
    totals: { ...report.totals },
    modelCalls: report.modelCalls,
    githubCalls: report.githubCalls,
    injectedFailures: report.injectedFailures,
  };
}

export function aggregateMonteCarlo(
  summaries: MonteCarloRunSummary[],
  thresholds: MonteCarloThresholds = {},
): MonteCarloReport {
  const runSummaries = [...summaries].sort((a, b) => a.run - b.run);

  const totals: Record<SimTerminalState, number> = { shipped: 0, parked: 0, escalated: 0 };
  let totalIssues = 0;
  let modelCalls = 0;
  let githubCalls = 0;
  let injectedFailures = 0;

  for (const summary of runSummaries) {
    totalIssues += summary.issues;
    totals.shipped += summary.totals.shipped;
    totals.parked += summary.totals.parked;
    totals.escalated += summary.totals.escalated;
    modelCalls += summary.modelCalls;
    githubCalls += summary.githubCalls;
    injectedFailures += summary.injectedFailures;
  }

  const rates: MonteCarloRates =
    totalIssues === 0
      ? { shipped: 0, parked: 0, escalated: 0, failure: 0 }
      : {
          shipped: totals.shipped / totalIssues,
          parked: totals.parked / totalIssues,
          escalated: totals.escalated / totalIssues,
          failure: (totals.parked + totals.escalated) / totalIssues,
        };

  const breaches: MonteCarloBreach[] = [];
  if (thresholds.maxFailureRate !== undefined && rates.failure > thresholds.maxFailureRate) {
    breaches.push({ metric: 'failure', rate: rates.failure, threshold: thresholds.maxFailureRate });
  }
  if (thresholds.maxParkRate !== undefined && rates.parked > thresholds.maxParkRate) {
    breaches.push({ metric: 'parked', rate: rates.parked, threshold: thresholds.maxParkRate });
  }
  if (thresholds.maxEscalationRate !== undefined && rates.escalated > thresholds.maxEscalationRate) {
    breaches.push({ metric: 'escalated', rate: rates.escalated, threshold: thresholds.maxEscalationRate });
  }

  return {
    runs: runSummaries.length,
    totalIssues,
    totals,
    rates,
    modelCalls,
    githubCalls,
    injectedFailures,
    runSummaries,
    thresholds,
    breaches,
  };
}

export async function runMonteCarlo(options: MonteCarloOptions): Promise<MonteCarloReport> {
  if (!Number.isInteger(options.runs) || options.runs < 1) {
    throw new RangeError('runMonteCarlo: runs must be a positive integer');
  }
  if (options.concurrency !== undefined && (!Number.isInteger(options.concurrency) || options.concurrency < 1)) {
    throw new RangeError('runMonteCarlo: concurrency must be a positive integer');
  }

  const simulate = options.simulate ?? ((simOptions: SimulationOptions) => runSimulation(simOptions));
  const jitter = options.simulation.jitter;
  const limit = Math.min(options.concurrency ?? 1, options.runs);
  const summaries: MonteCarloRunSummary[] = new Array(options.runs);

  let next = 0;
  const worker = async (): Promise<void> => {
    let run: number;
    while ((run = next++) < options.runs) {
      const seed = jitter ? deriveSimSeed(jitter.seed, run) : null;
      const simOptions: SimulationOptions = jitter
        ? { ...options.simulation, jitter: { ...jitter, seed } as SimJitterConfig }
        : { ...options.simulation };
      const report = await simulate(simOptions, run);
      const summary = summarizeSimulationRun(run, seed, report);
      summaries[run] = summary;
      options.onRunComplete?.(summary);
    }
  };

  await Promise.all(Array.from({ length: limit }, () => worker()));

  return aggregateMonteCarlo(summaries, options.thresholds);
}

function formatPercent(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

export function renderMonteCarloTable(report: MonteCarloReport): string {
  const lines: string[] = [];
  const cols = [
    { key: 'run', width: 3 },
    { key: 'seed', width: 10 },
    { key: 'issues', width: 6 },
    { key: 'shipped', width: 7 },
    { key: 'parked', width: 6 },
    { key: 'escalated', width: 9 },
    { key: 'model', width: 5 },
    { key: 'github', width: 6 },
    { key: 'injected', width: 8 },
  ];

  const header = cols.map((c) => c.key.padEnd(c.width)).join('  ');
  lines.push(header);

  for (const summary of report.runSummaries) {
    const row = [
      String(summary.run).padEnd(cols[0]!.width),
      (summary.seed === null ? '-' : String(summary.seed)).padEnd(cols[1]!.width),
      String(summary.issues).padEnd(cols[2]!.width),
      String(summary.totals.shipped).padEnd(cols[3]!.width),
      String(summary.totals.parked).padEnd(cols[4]!.width),
      String(summary.totals.escalated).padEnd(cols[5]!.width),
      String(summary.modelCalls).padEnd(cols[6]!.width),
      String(summary.githubCalls).padEnd(cols[7]!.width),
      String(summary.injectedFailures).padEnd(cols[8]!.width),
    ].join('  ');
    lines.push(row);
  }

  const totalRow = [
    'TOTAL'.padEnd(cols[0]!.width),
    ''.padEnd(cols[1]!.width),
    String(report.totalIssues).padEnd(cols[2]!.width),
    String(report.totals.shipped).padEnd(cols[3]!.width),
    String(report.totals.parked).padEnd(cols[4]!.width),
    String(report.totals.escalated).padEnd(cols[5]!.width),
    String(report.modelCalls).padEnd(cols[6]!.width),
    String(report.githubCalls).padEnd(cols[7]!.width),
    String(report.injectedFailures).padEnd(cols[8]!.width),
  ].join('  ');
  lines.push(totalRow);

  lines.push(
    `rates: shipped ${formatPercent(report.rates.shipped)}  parked ${formatPercent(report.rates.parked)}  ` +
      `escalated ${formatPercent(report.rates.escalated)}  failure ${formatPercent(report.rates.failure)}  ` +
      `(${report.totalIssues} issue outcomes over ${report.runs} runs)`,
  );

  const thresholdParts: string[] = [];
  if (report.thresholds.maxFailureRate !== undefined)
    thresholdParts.push(`failure<=${formatPercent(report.thresholds.maxFailureRate)}`);
  if (report.thresholds.maxParkRate !== undefined)
    thresholdParts.push(`parked<=${formatPercent(report.thresholds.maxParkRate)}`);
  if (report.thresholds.maxEscalationRate !== undefined)
    thresholdParts.push(`escalated<=${formatPercent(report.thresholds.maxEscalationRate)}`);
  const hasThreshold = thresholdParts.length > 0;
  if (hasThreshold) lines.push(`thresholds: ${thresholdParts.join('  ')}`);

  if (report.breaches.length > 0) {
    for (const breach of report.breaches) {
      lines.push(
        `BREACH: ${breach.metric} rate ${formatPercent(breach.rate)} exceeds ${formatPercent(breach.threshold)}`,
      );
    }
  } else if (hasThreshold) {
    lines.push('no threshold breaches');
  }

  return lines.join('\n');
}

export function monteCarloExitCode(report: MonteCarloReport): number {
  return report.breaches.length > 0 ? 1 : 0;
}
