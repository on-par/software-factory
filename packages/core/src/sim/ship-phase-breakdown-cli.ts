// packages/core/src/sim/ship-phase-breakdown-cli.ts — drives one clean sim reproduction (real
// PLAN -> BUILD -> CHECK -> SHIP phase code, no network) and renders its captured events through
// `renderShipPhaseBreakdown`. Modeled on monte-carlo-cli.ts: every effect (stdout, the runner
// itself) is injected so this is unit testable; scripts/ship-phase-breakdown-report.ts owns
// turning the return value into a process exit code (#1328).

import { renderShipPhaseBreakdown } from '../reports/ship-phase-breakdown.js';
import { runSimulation, type SimulationOptions, type SimulationReport } from './pipeline.js';

export interface ShipPhaseBreakdownCliDeps {
  write?: (line: string) => void;
  run?: (options: SimulationOptions) => Promise<SimulationReport>;
}

const REPRODUCTION_ISSUE = { issue: 9700, title: 'Ship phase breakdown reproduction (#1328)' };

/** Runs one clean sim reproduction and writes its markdown breakdown. Returns 0 when the
 *  reproduction shipped, 1 otherwise (mirrors the monte-carlo CLI's non-throwing exit contract). */
export async function runShipPhaseBreakdownReportCli(deps: ShipPhaseBreakdownCliDeps = {}): Promise<number> {
  const write = deps.write ?? ((line: string) => process.stdout.write(line));
  const run = deps.run ?? runSimulation;

  const report = await run({ issues: [REPRODUCTION_ISSUE] });
  const [outcome] = report.outcomes;
  if (!outcome) {
    write('ship-phase-breakdown-report: the sim reproduction produced no outcome\n');
    return 1;
  }

  write(renderShipPhaseBreakdown(outcome.events));
  return outcome.state === 'shipped' ? 0 : 1;
}
