import { resolveSliceGate } from '../readiness/slice-gate.js';

type GateDeps = Parameters<typeof resolveSliceGate>[0];

export async function routeStackSlice(
  deps: GateDeps & { planningSlice: boolean; sliceLabel: string; scope: string; fileReason: string },
): Promise<{ reason: string; sliceCount?: number } | undefined> {
  const { planningSlice, sliceLabel, scope, fileReason, log } = deps;
  if (planningSlice) {
    const reason = `${sliceLabel} exceeds the bounded-build budget (${scope}) — parked; a slice is never sliced again`;
    log('size-gate-escalated', reason);
    return { reason };
  }
  const gate = await resolveSliceGate(deps);
  if (gate.kind === 'cohesive') return undefined;
  if (gate.kind === 'slice') {
    return {
      reason: `plan scope exceeds the bounded-build budget (${scope}) — sliced into ${gate.plan.slices.length} slice(s); the next run plans slice ${gate.slice.index}`,
      sliceCount: gate.plan.slices.length,
    };
  }
  if (gate.kind === 'over-cap' || gate.kind === 'unsliceable') {
    log('size-gate-escalated', gate.reason);
    return { reason: gate.reason };
  }
  const reason = gate.kind === 'park' ? gate.reason : fileReason;
  log('escalate', reason);
  return { reason };
}
