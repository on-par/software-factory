// #3126 — token capture coverage: compares agent invocations from the event log
// with cost rows, per phase and per harness, so a missing row is measurable.
import { phaseOfCostEntry, phaseOfTask } from '../kpis/phase.js';
import type { CostEntry, FactoryEvent } from '../types/index.js';

export interface AgentInvocation {
  phase: string;
  harness: string;
  task: string;
  model: string;
}

export interface TokenCoverageEntry {
  key: string;
  invocations: number;
  rows: number;
  /** rows / invocations; null (not 0) when nothing was invoked. Not clamped. */
  coverage: number | null;
}

export interface TokenCoverage {
  phases: TokenCoverageEntry[];
  harnesses: TokenCoverageEntry[];
  /** Sorted phases that invoked a model but have fewer rows than invocations. */
  gaps: string[];
  /** Cost rows whose task maps to no phase. */
  unattributedRows: number;
}

/** ModelRouter.run logs this line before every attempt. */
export const ROUTER_TRYING = /^Trying (\S+) for (\S+) \(attempt \d+\)$/;
/** ModelRouter.run logs this line for every failed attempt (anchored, so the
 *  "— non-retryable" variant does not subtract twice). */
export const ROUTER_FAILED = /^(\S+) failed \([^)]+\) on (\S+)$/;

const PHASE_STARTED = /^(\w+) started$/;

export function agentInvocationsFromEvents(
  events: readonly FactoryEvent[],
  harnessOf: (model: string) => string,
): AgentInvocation[] {
  const invocations: AgentInvocation[] = [];
  let currentPhase: string | null = null;
  for (const event of events) {
    if (event.type === 'phase_started') {
      currentPhase = event.phase ?? PHASE_STARTED.exec(event.msg)?.[1] ?? currentPhase;
      continue;
    }
    if (event.type !== 'router') continue;
    const trying = ROUTER_TRYING.exec(event.msg);
    if (trying) {
      const [, model = '', task = ''] = trying;
      invocations.push({
        phase: currentPhase ?? phaseOfTask(task) ?? 'unknown',
        harness: harnessOf(model),
        task,
        model,
      });
      continue;
    }
    const failed = ROUTER_FAILED.exec(event.msg);
    if (failed) {
      const [, model = '', task = ''] = failed;
      let index = invocations.length - 1;
      while (index >= 0 && !(invocations[index]?.model === model && invocations[index]?.task === task)) index -= 1;
      if (index >= 0) invocations.splice(index, 1);
    }
  }
  return invocations;
}

function bump(map: Map<string, { invocations: number; rows: number }>, key: string, field: 'invocations' | 'rows') {
  const slot = map.get(key) ?? { invocations: 0, rows: 0 };
  slot[field] += 1;
  map.set(key, slot);
}

function toEntries(map: Map<string, { invocations: number; rows: number }>): TokenCoverageEntry[] {
  return [...map.entries()]
    .map(([key, { invocations, rows }]) => ({
      key,
      invocations,
      rows,
      coverage: invocations === 0 ? null : rows / invocations,
    }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

export function computeTokenCoverage(
  invocations: readonly AgentInvocation[],
  costs: readonly CostEntry[],
  harnessOf: (model: string) => string,
): TokenCoverage {
  const byPhase = new Map<string, { invocations: number; rows: number }>();
  const byHarness = new Map<string, { invocations: number; rows: number }>();
  let unattributedRows = 0;
  for (const inv of invocations) {
    bump(byPhase, inv.phase, 'invocations');
    bump(byHarness, inv.harness, 'invocations');
  }
  for (const entry of costs) {
    const phase = phaseOfCostEntry(entry);
    if (phase === null) unattributedRows += 1;
    else bump(byPhase, phase, 'rows');
    bump(byHarness, harnessOf(entry.model), 'rows');
  }
  const phases = toEntries(byPhase);
  return {
    phases,
    harnesses: toEntries(byHarness),
    gaps: phases.filter((p) => p.invocations > 0 && (p.coverage ?? 0) < 1).map((p) => p.key),
    unattributedRows,
  };
}
