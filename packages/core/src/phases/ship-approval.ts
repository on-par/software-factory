// packages/core/src/phases/ship-approval.ts — SHIP approval gate request

import type { ApprovalGate } from '../approvals/index.js';
import type { CheckSummary } from '../types/index.js';
import { issueNumberOf, type WorkKey } from '../work/work-key.js';
import { computeDiffStat } from './ship-diff-stat.js';
import type { CommandRunner } from './ship-git.js';
import type { ShipPhaseOptions } from './ship-options.js';
import type { ShipResult } from './ship-types.js';

export async function requestShipApproval(ctx: {
  approvalGate: ApprovalGate;
  issue: WorkKey;
  branch: string;
  worktree: string;
  base: string;
  run: CommandRunner;
  checkSummary?: CheckSummary;
  log: ShipPhaseOptions['log'];
}): Promise<ShipResult | undefined> {
  const { approvalGate, issue, branch, worktree, base, run, checkSummary, log } = ctx;
  // Log a 'ship'-typed event before anything else so the TUI's activePhase
  // advances to SHIP first — otherwise a denial reports failedPhase as
  // whichever phase (CHECK/BUILD) last logged, which is misleading.
  log('ship', `Starting ship phase for ${branch}`);
  const diffStat = await computeDiffStat(run, worktree, base);
  log(
    'approval_requested',
    `awaiting approval to ship ${branch}${checkSummary ? ` (checks: ${checkSummary.passes} pass, ${checkSummary.failures} fail, ${checkSummary.skips} skip)` : ''}`,
  );
  const response = await approvalGate({ issue: issueNumberOf(issue), branch, worktree, diffStat, checkSummary });
  if (!response.approved) {
    const reason = response.reason ?? 'denied';
    log('ship_denied', `ship denied for ${branch}: ${reason}`);
    return { ok: false, denied: true, deniedReason: reason };
  }
  log('approval_granted', `approval granted for ${branch}`);
  return undefined;
}
