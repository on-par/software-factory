// packages/core/src/run/budget.ts — per-issue budget enforcement (#3316)

import { type WorkKey, issueNumberOf } from '../work/work-key.js';
import type { ProcessGroupTracker } from '../environment/process-groups.js';
import type { EventKind } from '../events/kinds.js';
import type { BudgetGuard } from '../router/budget-guard.js';
import { upsertWorktreeKeep } from '../utils/worktree-keeps.js';

export const BUDGET_KEEP_REASON = 'budget_exceeded';

/** Spend and model call at which the budget guard stopped a live session (#3320). */
export interface SessionBudgetStop {
  spendUsd: number;
  calls: number;
}

/** Build the live guard for BUILD/rework sessions: on the first update where committed plus running spend passes
 *  the cap it records the stop and kills the lane's process groups. No cap, no guard. */
export function budgetGuardFor(
  policy: { budget: { perIssueCapUsd?: number } },
  ports: { getIssueSpend?: () => number },
  tracker: Pick<ProcessGroupTracker, 'killAll'>,
  graceMs?: number,
  log?: (type: EventKind, msg: string) => void,
): { guard: BudgetGuard | undefined; stopped: () => SessionBudgetStop | undefined } {
  const cap = policy.budget.perIssueCapUsd;
  if (cap === undefined) return { guard: undefined, stopped: () => undefined };
  let stop: SessionBudgetStop | undefined;
  const guard: BudgetGuard = (runningUsd, calls) => {
    if (stop) return true;
    const spendUsd = (ports.getIssueSpend?.() ?? 0) + runningUsd;
    if (spendUsd <= cap) return false;
    stop = { spendUsd, calls };
    void tracker.killAll({ graceMs }).catch((err: unknown) => {
      log?.('warn', `budget kill failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    return true;
  };
  return { guard, stopped: () => stop };
}

/** Returns the park message when `spend` exceeds `cap`, else undefined. An over-budget park
 *  also records a keep for the worktree so GC leaves the nearly finished work alone. */
export function enforceIssueBudget(input: {
  phase: string;
  spend: number;
  cap: number | undefined;
  issue: WorkKey;
  worktreePath: string;
  keepsFile?: string;
  log: (type: EventKind, msg: string) => void;
  now?: () => Date;
  /** Set when the guard stopped a live session; always parks, with the during-phase message. */
  stop?: SessionBudgetStop;
}): string | undefined {
  const { phase, spend, cap, issue, worktreePath, keepsFile, log, now, stop } = input;
  if (cap === undefined || (!stop && spend <= cap)) return undefined;
  const message = stop
    ? `per-issue budget exceeded during ${phase}: $${stop.spendUsd.toFixed(2)} > $${cap.toFixed(2)} (stopped at model call ${stop.calls})`
    : `per-issue budget exceeded after ${phase}: $${spend.toFixed(2)} > $${cap.toFixed(2)}`;
  log('budget_exceeded', message);
  if (keepsFile) {
    try {
      upsertWorktreeKeep(keepsFile, {
        issue: issueNumberOf(issue),
        path: worktreePath,
        reason: BUDGET_KEEP_REASON,
        since: (now?.() ?? new Date()).toISOString(),
      });
    } catch (err: any) {
      log('warn', `could not record the kept worktree for #${issue}: ${err?.message ?? String(err)}`);
    }
  }
  return message;
}
