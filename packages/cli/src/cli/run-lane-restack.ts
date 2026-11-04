// packages/cli/src/cli/run-lane-restack.ts — runLane's model-free restack step, split out of run-lane.ts (ADR-0161)

import type {
  PrerequisiteRestackDecision,
  PrerequisiteRestackOutcome,
  StackRestackOutcome,
} from '@on-par/factory-core/internal';

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

/** Restacks a PR stacked on a prerequisite (#3916) while keeping the claim lease fresh; a park comes back as a park reason. */
export async function restackPrerequisiteUnderHeartbeat(
  issue: number,
  heartbeat: ((issue: number) => Promise<unknown>) | undefined,
  restackPrerequisite: (decision: PrerequisiteRestackDecision) => Promise<PrerequisiteRestackOutcome>,
  decision: PrerequisiteRestackDecision,
): Promise<{ parkReason?: string; note: string }> {
  try {
    const out = await withHeartbeat(issue, heartbeat, () => restackPrerequisite(decision));
    if (out.status === 'park') return { parkReason: out.reason, note: out.reason };
    const onto = decision.onto.kind === 'main' ? 'main' : `prerequisite PR #${decision.stackedOn.prNumber}'s new head`;
    return {
      note: `restacked PR #${decision.prNumber} onto ${onto}${out.retargeted ? ' and retargeted it to main' : ''}`,
    };
  } catch (err) {
    const reason = `prerequisite restack failed: ${shipRuntime().errorDetail(err)}`;
    return { parkReason: reason, note: reason };
  }
}
