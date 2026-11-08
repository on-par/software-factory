// packages/core/src/phases/ship-visual-proof.ts — SHIP UI visual proof gate wrapper and failure reason (#2232)

import type { VisualProofResult } from '../checkers/visual-proof.js';
import type { EventKind } from '../events/kinds.js';

/** Classifies, captures, attaches and publishes visual proof for the PR's exact head. */
export type VisualProofGate = (pr: { prNumber: number; headSha: string }) => Promise<VisualProofResult>;

const CI_PENDING_DIAGNOSTIC = 'CI pending, visual proof not captured';

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const unavailable = (headSha: string, diagnostic: string): VisualProofResult => ({
  status: 'unavailable',
  headSha,
  runId: '',
  captures: [],
  diagnostic,
});

export async function runVisualProofGate(
  gate: VisualProofGate,
  pr: { prNumber: number; headSha: string },
  ctx: { log: (type: EventKind, msg: string) => void; ciPending: boolean },
): Promise<VisualProofResult> {
  let result: VisualProofResult;
  if (ctx.ciPending) {
    result = unavailable(pr.headSha, CI_PENDING_DIAGNOSTIC);
  } else {
    try {
      result = await gate(pr);
    } catch (err) {
      result = unavailable(pr.headSha, errorMessage(err));
    }
  }
  ctx.log(
    'ship',
    `visual proof ${result.status} for PR #${pr.prNumber} (${pr.headSha.slice(0, 12)})` +
      (result.diagnostic ? `: ${result.diagnostic}` : ''),
  );
  return result;
}

export function visualProofFailureReason(prNumber: number, result: VisualProofResult): string {
  return `visual proof ${result.status} for PR #${prNumber} at ${result.headSha.slice(0, 12)}: ${result.diagnostic ?? 'no diagnostic recorded'}`;
}
