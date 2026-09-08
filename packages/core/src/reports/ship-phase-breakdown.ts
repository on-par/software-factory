// src/reports/ship-phase-breakdown.ts — pure aggregator: durations per PLAN/BUILD/CHECK/SHIP
// phase, per checker, and for ADR-constraint injection inside PLAN, from a run's event log.
// Modeled on local-run.ts. Takes the shared `{ ts, type, msg, phase?, durationMs? }` shape that
// both a real `.factory/events.ndjson` read (FactoryEvent) and the sim harness's replay
// (SimPipelineEvent) satisfy since #1324/#1328 — this module depends on neither directly, so it
// stays a pure function with no I/O (#1328).

export interface ShipPhaseBreakdownEvent {
  ts: string;
  type: string;
  msg: string;
  phase?: string;
  durationMs?: number;
}

export interface ShipPhaseBreakdownRow {
  name: string;
  durationMs: number;
  count: number;
}

export interface ShipPhaseBreakdown {
  /** Sum of every `phase_completed` event's `durationMs` — PLAN + BUILD + CHECK + SHIP. */
  totalDurationMs: number;
  /** One row per phase, descending by duration. */
  phases: ShipPhaseBreakdownRow[];
  /** One row per checker name (parsed from `checker_completed`'s message), descending by
   *  duration. A subset of the CHECK phase's own duration, not additional to it. */
  checkers: ShipPhaseBreakdownRow[];
  /** Sum of every `adr_inject_completed` event's `durationMs` — a subset of PLAN's duration. */
  adrInjectionMs: number;
}

const CHECKER_NAME_RE = /^checker (.+) completed \(/;

function parseCheckerName(msg: string): string | undefined {
  return CHECKER_NAME_RE.exec(msg)?.[1];
}

function addRow(rows: Map<string, ShipPhaseBreakdownRow>, name: string, durationMs: number): void {
  const existing = rows.get(name);
  if (existing) {
    existing.durationMs += durationMs;
    existing.count += 1;
  } else {
    rows.set(name, { name, durationMs, count: 1 });
  }
}

function sortedRows(rows: Map<string, ShipPhaseBreakdownRow>): ShipPhaseBreakdownRow[] {
  return [...rows.values()].sort((a, b) => b.durationMs - a.durationMs);
}

export function aggregateShipPhaseBreakdown(events: ShipPhaseBreakdownEvent[]): ShipPhaseBreakdown {
  const phaseRows = new Map<string, ShipPhaseBreakdownRow>();
  const checkerRows = new Map<string, ShipPhaseBreakdownRow>();
  let adrInjectionMs = 0;

  for (const event of events) {
    if (event.durationMs === undefined) continue;
    if (event.type === 'phase_completed' && event.phase) {
      addRow(phaseRows, event.phase, event.durationMs);
    } else if (event.type === 'checker_completed') {
      const name = parseCheckerName(event.msg);
      if (name) addRow(checkerRows, name, event.durationMs);
    } else if (event.type === 'adr_inject_completed') {
      adrInjectionMs += event.durationMs;
    }
  }

  const totalDurationMs = [...phaseRows.values()].reduce((sum, row) => sum + row.durationMs, 0);

  return {
    totalDurationMs,
    phases: sortedRows(phaseRows),
    checkers: sortedRows(checkerRows),
    adrInjectionMs,
  };
}

function percentOf(durationMs: number, totalDurationMs: number): string {
  return totalDurationMs > 0 ? `${((durationMs / totalDurationMs) * 100).toFixed(1)}%` : 'n/a';
}

function table(header: string[], rows: string[][]): string {
  const lines = [`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`];
  if (rows.length === 0) {
    lines.push(`| ${header.map((_, i) => (i === 0 ? '_none recorded_' : '')).join(' | ')} |`);
  } else {
    lines.push(...rows.map((row) => `| ${row.join(' | ')} |`));
  }
  return lines.join('\n');
}

/** Renders `aggregateShipPhaseBreakdown`'s result as a markdown report. */
export function renderShipPhaseBreakdown(events: ShipPhaseBreakdownEvent[]): string {
  const breakdown = aggregateShipPhaseBreakdown(events);

  return [
    '# Ship-phase duration breakdown',
    '',
    `- Total measured phase duration: ${breakdown.totalDurationMs}ms`,
    `- ADR injection (subset of PLAN): ${breakdown.adrInjectionMs}ms`,
    '',
    '## By phase',
    '',
    table(
      ['phase', 'durationMs', '% of total', 'count'],
      breakdown.phases.map((row) => [
        row.name,
        String(row.durationMs),
        percentOf(row.durationMs, breakdown.totalDurationMs),
        String(row.count),
      ]),
    ),
    '',
    '## By checker (subset of CHECK)',
    '',
    table(
      ['checker', 'durationMs', 'count'],
      breakdown.checkers.map((row) => [row.name, String(row.durationMs), String(row.count)]),
    ),
    '',
  ].join('\n');
}
