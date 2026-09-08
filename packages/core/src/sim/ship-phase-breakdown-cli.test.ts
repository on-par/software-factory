import { describe, expect, it } from 'vitest';

import { runShipPhaseBreakdownReportCli } from './ship-phase-breakdown-cli.js';
import type { SimIssueOutcome, SimulationReport } from './pipeline.js';

function outcome(overrides: Partial<SimIssueOutcome> = {}): SimIssueOutcome {
  return {
    issue: 9700,
    state: 'shipped',
    phase: 'ship',
    route: 'claude',
    branch: 'ship-it/9700-test',
    reworkRounds: 0,
    modelCalls: [],
    githubCalls: [],
    jitterDraws: [],
    designArtifact: null,
    events: [
      { ts: '2026-09-08T00:00:00.000Z', phase: 'plan', type: 'phase_completed', msg: 'plan done', durationMs: 100 },
    ],
    ...overrides,
  };
}

describe('runShipPhaseBreakdownReportCli', () => {
  it('writes the rendered breakdown and exits 0 for a shipped reproduction', async () => {
    const written: string[] = [];
    const exitCode = await runShipPhaseBreakdownReportCli({
      write: (line) => written.push(line),
      run: async () =>
        ({
          outcomes: [outcome()],
          totals: { shipped: 1, parked: 0, escalated: 0 },
          modelCalls: 0,
          githubCalls: 0,
          injectedFailures: 0,
        }) satisfies SimulationReport,
    });
    expect(exitCode).toBe(0);
    expect(written.join('')).toContain('# Ship-phase duration breakdown');
  });

  it('exits 1 when the reproduction did not ship', async () => {
    const exitCode = await runShipPhaseBreakdownReportCli({
      write: () => {},
      run: async () =>
        ({
          outcomes: [outcome({ state: 'parked', reason: 'sim: forced failure' })],
          totals: { shipped: 0, parked: 1, escalated: 0 },
          modelCalls: 0,
          githubCalls: 0,
          injectedFailures: 0,
        }) satisfies SimulationReport,
    });
    expect(exitCode).toBe(1);
  });

  it('exits 1 and writes a diagnostic when the run produces no outcome', async () => {
    const written: string[] = [];
    const exitCode = await runShipPhaseBreakdownReportCli({
      write: (line) => written.push(line),
      run: async () =>
        ({
          outcomes: [],
          totals: { shipped: 0, parked: 0, escalated: 0 },
          modelCalls: 0,
          githubCalls: 0,
          injectedFailures: 0,
        }) satisfies SimulationReport,
    });
    expect(exitCode).toBe(1);
    expect(written.join('')).toContain('no outcome');
  });

  it('defaults to the real runSimulation and produces a shipped clean reproduction', async () => {
    const written: string[] = [];
    const exitCode = await runShipPhaseBreakdownReportCli({ write: (line) => written.push(line) });
    expect(exitCode).toBe(0);
    expect(written.join('')).toContain('# Ship-phase duration breakdown');
  }, 60_000);
});
