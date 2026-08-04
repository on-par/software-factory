import { describe, expect, it } from 'vitest';

import { deriveSimSeed, type SimJitterConfig } from './jitter.js';
import {
  aggregateMonteCarlo,
  monteCarloExitCode,
  renderMonteCarloTable,
  runMonteCarlo,
  summarizeSimulationRun,
  type MonteCarloRunSummary,
} from './monte-carlo.js';
import type { SimIssueOutcome, SimulationOptions, SimulationReport } from './pipeline.js';
import type { SimTerminalState } from './types.js';

function fakeReport(
  totals: Partial<Record<SimTerminalState, number>>,
  extra?: Partial<Pick<SimulationReport, 'modelCalls' | 'githubCalls' | 'injectedFailures'>>,
): SimulationReport {
  const full: Record<SimTerminalState, number> = { shipped: 0, parked: 0, escalated: 0, ...totals };
  const outcomes: SimIssueOutcome[] = [];
  let issue = 1;
  for (const state of ['shipped', 'parked', 'escalated'] as SimTerminalState[]) {
    for (let i = 0; i < full[state]; i++) {
      outcomes.push({
        issue: issue++,
        state,
        phase: state === 'shipped' ? 'ship' : 'check',
        route: 'claude',
        branch: `sim/fake-${issue}`,
        reworkRounds: 0,
        modelCalls: [],
        githubCalls: [],
        jitterDraws: [],
        events: [],
      });
    }
  }
  return {
    outcomes,
    totals: full,
    modelCalls: extra?.modelCalls ?? 0,
    githubCalls: extra?.githubCalls ?? 0,
    injectedFailures: extra?.injectedFailures ?? 0,
  };
}

describe('summarizeSimulationRun', () => {
  it('collapses a SimulationReport into a MonteCarloRunSummary', () => {
    const report = fakeReport({ shipped: 2, parked: 1 }, { modelCalls: 6, githubCalls: 9, injectedFailures: 3 });
    const summary = summarizeSimulationRun(2, 12345, report);
    expect(summary).toEqual({
      run: 2,
      seed: 12345,
      issues: 3,
      totals: { shipped: 2, parked: 1, escalated: 0 },
      modelCalls: 6,
      githubCalls: 9,
      injectedFailures: 3,
    });
  });

  it('reports seed null verbatim', () => {
    const summary = summarizeSimulationRun(0, null, fakeReport({ shipped: 1 }));
    expect(summary.seed).toBeNull();
  });
});

describe('aggregateMonteCarlo', () => {
  it('aggregates counts and rates across runs', () => {
    const summaries: MonteCarloRunSummary[] = [
      summarizeSimulationRun(0, 1, fakeReport({ shipped: 2, parked: 0, escalated: 0 })),
      summarizeSimulationRun(1, 2, fakeReport({ shipped: 1, parked: 1, escalated: 0 })),
      summarizeSimulationRun(2, 3, fakeReport({ shipped: 0, parked: 1, escalated: 1 })),
    ];
    const report = aggregateMonteCarlo(summaries);
    expect(report.runs).toBe(3);
    expect(report.totalIssues).toBe(6);
    expect(report.totals).toEqual({ shipped: 3, parked: 2, escalated: 1 });
    expect(report.rates.shipped).toBeCloseTo(3 / 6);
    expect(report.rates.parked).toBeCloseTo(2 / 6);
    expect(report.rates.escalated).toBeCloseTo(1 / 6);
    expect(report.rates.failure).toBeCloseTo((2 + 1) / 6);
    expect(report.rates.failure).toBe(report.rates.parked + report.rates.escalated);
  });

  it('zero issues yields all-zero rates and no NaN', () => {
    const summaries = [summarizeSimulationRun(0, null, fakeReport({}))];
    const report = aggregateMonteCarlo(summaries);
    expect(report.totalIssues).toBe(0);
    expect(report.rates).toEqual({ shipped: 0, parked: 0, escalated: 0, failure: 0 });
    expect(report.breaches).toEqual([]);
  });

  it('sorts runSummaries by run regardless of input order', () => {
    const summaries = [
      summarizeSimulationRun(2, 3, fakeReport({ shipped: 1 })),
      summarizeSimulationRun(0, 1, fakeReport({ shipped: 1 })),
      summarizeSimulationRun(1, 2, fakeReport({ shipped: 1 })),
    ];
    const report = aggregateMonteCarlo(summaries);
    expect(report.runSummaries.map((s) => s.run)).toEqual([0, 1, 2]);
  });

  it('breaches for each metric strictly above threshold; equality does not breach; unset never breaches', () => {
    const summaries = [summarizeSimulationRun(0, 1, fakeReport({ shipped: 5, parked: 3, escalated: 2 }))];

    const exact = aggregateMonteCarlo(summaries, { maxFailureRate: 0.5 });
    expect(exact.breaches).toEqual([]);

    const overFailure = aggregateMonteCarlo(summaries, { maxFailureRate: 0.49 });
    expect(overFailure.breaches).toEqual([{ metric: 'failure', rate: 0.5, threshold: 0.49 }]);

    const overPark = aggregateMonteCarlo(summaries, { maxParkRate: 0.29 });
    expect(overPark.breaches).toEqual([{ metric: 'parked', rate: 0.3, threshold: 0.29 }]);

    const overEscalation = aggregateMonteCarlo(summaries, { maxEscalationRate: 0.19 });
    expect(overEscalation.breaches).toEqual([{ metric: 'escalated', rate: 0.2, threshold: 0.19 }]);

    const noThresholds = aggregateMonteCarlo(summaries);
    expect(noThresholds.breaches).toEqual([]);

    expect(monteCarloExitCode(overFailure)).toBe(1);
    expect(monteCarloExitCode(exact)).toBe(0);
  });
});

describe('renderMonteCarloTable', () => {
  it('renders a row per run, a TOTAL row, the rates line, and a BREACH line', () => {
    const summaries = [
      summarizeSimulationRun(0, 111, fakeReport({ shipped: 1, parked: 1 })),
      summarizeSimulationRun(1, null, fakeReport({ shipped: 2 })),
    ];
    const report = aggregateMonteCarlo(summaries, { maxFailureRate: 0.1 });
    const table = renderMonteCarloTable(report);

    expect(table).toContain('run');
    expect(table).toContain('seed');
    expect(table).toContain('shipped');
    expect(table).toContain('111');
    expect(table).toContain('-');
    expect(table).toContain('TOTAL');
    expect(table).toContain('rates: shipped');
    expect(table).toContain('failure');
    expect(table).toContain('4 issue outcomes over 2 runs');
    expect(table).toContain('thresholds: failure<=10.0%');
    expect(table).toContain('BREACH: failure rate 25.0% exceeds 10.0%');
  });

  it('prints "no threshold breaches" when a threshold is configured and held', () => {
    const summaries = [summarizeSimulationRun(0, 1, fakeReport({ shipped: 4 }))];
    const report = aggregateMonteCarlo(summaries, { maxFailureRate: 0.5 });
    expect(renderMonteCarloTable(report)).toContain('no threshold breaches');
  });

  it('omits the thresholds line entirely when no threshold is set', () => {
    const summaries = [summarizeSimulationRun(0, 1, fakeReport({ shipped: 4 }))];
    const report = aggregateMonteCarlo(summaries);
    const table = renderMonteCarloTable(report);
    expect(table).not.toContain('thresholds:');
    expect(table).not.toContain('BREACH');
    expect(table).not.toContain('no threshold breaches');
  });
});

describe('runMonteCarlo', () => {
  it('rejects invalid runs / concurrency', async () => {
    const simulate = async () => fakeReport({ shipped: 1 });
    await expect(runMonteCarlo({ runs: 0, simulation: { issues: [] }, simulate })).rejects.toThrow(RangeError);
    await expect(runMonteCarlo({ runs: 1.5, simulation: { issues: [] }, simulate })).rejects.toThrow(RangeError);
    await expect(runMonteCarlo({ runs: 1, concurrency: 0, simulation: { issues: [] }, simulate })).rejects.toThrow(
      RangeError,
    );
  });

  it('derives a per-run seed and reuses the base seed for run 0; no call receives a workspace', async () => {
    const baseSeed = 777;
    const seenOptions: SimulationOptions[] = [];
    const simulate = async (options: SimulationOptions) => {
      seenOptions.push(options);
      return fakeReport({ shipped: 1 });
    };
    const report = await runMonteCarlo({
      runs: 4,
      simulation: { issues: [{ issue: 1, title: 'x' }], jitter: { seed: baseSeed } },
      simulate,
    });

    const seeds = report.runSummaries.map((s) => s.seed);
    expect(seeds[0]).toBe(baseSeed);
    expect(new Set(seeds).size).toBe(4);
    for (let r = 0; r < 4; r++) {
      expect(seeds[r]).toBe(deriveSimSeed(baseSeed, r));
    }
    for (const options of seenOptions) {
      expect(options).not.toHaveProperty('workspace');
    }
  });

  it('reports seed null when the simulation configures no jitter', async () => {
    const simulate = async () => fakeReport({ shipped: 1 });
    const report = await runMonteCarlo({ runs: 2, simulation: { issues: [] }, simulate });
    expect(report.runSummaries.every((s) => s.seed === null)).toBe(true);
  });

  it('honours concurrency and keeps run order even when runs resolve out of order', async () => {
    let inFlight = 0;
    let peak = 0;
    const resolveOrder = [2, 0, 1];
    const simulate = async (_options: SimulationOptions, run: number) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, resolveOrder.indexOf(run) * 5));
      inFlight--;
      return fakeReport({ shipped: 1 });
    };
    const report = await runMonteCarlo({ runs: 3, concurrency: 3, simulation: { issues: [] }, simulate });
    expect(peak).toBe(3);
    expect(report.runSummaries.map((s) => s.run)).toEqual([0, 1, 2]);
  });

  it('onRunComplete fires once per run', async () => {
    const completed: number[] = [];
    const simulate = async () => fakeReport({ shipped: 1 });
    await runMonteCarlo({
      runs: 3,
      simulation: { issues: [] },
      simulate,
      onRunComplete: (summary) => completed.push(summary.run),
    });
    expect(completed.sort()).toEqual([0, 1, 2]);
  });

  it('propagates a simulate rejection', async () => {
    const simulate = async () => {
      throw new Error('boom');
    };
    await expect(runMonteCarlo({ runs: 2, simulation: { issues: [] }, simulate })).rejects.toThrow('boom');
  });
});

describe('runMonteCarlo end-to-end', () => {
  it(
    'a clean 2-run batch of 1 issue ships everything with only fake calls (AC1/AC2)',
    { timeout: 180_000 },
    async () => {
      const report = await runMonteCarlo({
        runs: 2,
        simulation: { issues: [{ issue: 9500, title: 'Sim Monte Carlo clean issue' }], jitter: { seed: 7 } },
      });
      expect(report.totals.shipped).toBe(2);
      expect(report.rates.shipped).toBe(1);
      expect(report.rates.failure).toBe(0);
      expect(report.modelCalls).toBeGreaterThan(0);
      expect(report.githubCalls).toBeGreaterThan(0);
      expect(report.injectedFailures).toBe(0);
    },
  );

  it('100% BUILD failure breaches the threshold (AC3)', { timeout: 180_000 }, async () => {
    const jitter: SimJitterConfig = { seed: 4242, phases: { build: { failureRate: 1 } } };
    const report = await runMonteCarlo({
      runs: 2,
      simulation: {
        issues: [{ issue: 9501, title: 'Sim Monte Carlo build failure' }],
        jitter,
        clock: { sleep: async () => {}, random: () => 0.5 },
      },
      thresholds: { maxFailureRate: 0.5 },
    });
    expect(report.totals.shipped).toBe(0);
    expect(report.rates.failure).toBe(1);
    expect(report.breaches).toEqual([{ metric: 'failure', rate: 1, threshold: 0.5 }]);
    expect(monteCarloExitCode(report)).toBe(1);
  });
});
