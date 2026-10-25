// packages/cli/src/cli/run-lane-restack.ts — runLane's model-free restack step, split out of run-lane.ts (ADR-0161)

import type { StackRestackOutcome } from '@on-par/factory-core/internal';

import { withHeartbeat } from './lane-heartbeat.js';
import { shipRuntime } from './ship-runtime.js';

/** Restacks the open layers above a merged slice while keeping the claim lease fresh; a failure comes back as a park reason. */
export async function restackUnderHeartbeat(
  issue: number,
  heartbeat: ((issue: number) => Promise<unknown>) | undefined,
  restack: (issue: number, merged: { index: number; prNumber: number }) => Promise<StackRestackOutcome>,
  merged: { index: number; prNumber: number },
): Promise<{ parkReason?: string; note: string }> {
  try {
    const out = await withHeartbeat(issue, heartbeat, () => restack(issue, merged));
    if (out.status === 'park') return { parkReason: out.reason, note: out.reason };
    return {
      note:
        out.status === 'restacked'
          ? `restacked slice(s) ${out.slices.map((r) => r.index).join(', ')} onto main after slice ${merged.index} merged`
          : out.reason,
    };
  } catch (err) {
    const reason = `restack failed: ${shipRuntime().errorDetail(err)}`;
    return { parkReason: reason, note: reason };
  }
}
