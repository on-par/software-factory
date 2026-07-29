// packages/product/src/readiness/gate.ts — human gate #2, the handoff gate (#475).

import type { ReadinessReport } from './report.js';

export type HandoffDecision =
  | { ok: true; report: ReadinessReport; approvedBy: string }
  | { ok: false; report: ReadinessReport; blockers: readonly string[] };

/** The explicit human gate over the handoff — mirrors approveIntentDoc (human gate #1). */
export function gateHandoff(report: ReadinessReport, approvedBy: string): HandoffDecision {
  const blockers: string[] = report.dimensions.filter((d) => !d.ready).map((d) => d.reason);

  if (approvedBy.trim() === '') {
    blockers.push('handoff needs a named human approver');
  }

  if (blockers.length > 0) {
    return { ok: false, report, blockers };
  }

  return { ok: true, report, approvedBy: approvedBy.trim() };
}
