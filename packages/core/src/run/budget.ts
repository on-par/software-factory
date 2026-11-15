import type { ProcessGroupTracker } from '../environment/process-groups.js';
import type { EventKind } from '../events/kinds.js';
import type { BudgetGuard } from '../router/budget-guard.js';
import { upsertWorktreeKeep } from '../utils/worktree-keeps.js';
import { issueNumberOf, type WorkKey } from '../work/work-key.js';

export const BUDGET_KEEP_REASON = 'budget_exceeded';

export interface SessionBudgetStop {
  spendUsd: number;
  calls: number;
}

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

export function enforceIssueBudget(input: {
  phase: string;
  spend: number;
  cap: number | undefined;
  key: WorkKey;
  worktreePath: string;
  keepsFile?: string;
  log: (type: EventKind, msg: string) => void;
  now?: () => Date;
  stop?: SessionBudgetStop;
}): string | undefined {
  const { phase, spend, cap, key, worktreePath, keepsFile, log, now, stop } = input;
  if (cap === undefined || (!stop && spend <= cap)) return undefined;
  const message = stop
    ? `per-issue budget exceeded during ${phase}: $${stop.spendUsd.toFixed(2)} > $${cap.toFixed(2)} (stopped at model call ${stop.calls})`
    : `per-issue budget exceeded after ${phase}: $${spend.toFixed(2)} > $${cap.toFixed(2)}`;
  log('budget_exceeded', message);
  if (keepsFile) {
    try {
      upsertWorktreeKeep(keepsFile, {
        issue: issueNumberOf(key),
        path: worktreePath,
        reason: BUDGET_KEEP_REASON,
        since: (now?.() ?? new Date()).toISOString(),
      });
    } catch (err: any) {
      log('warn', `could not record the kept worktree for #${key}: ${err?.message ?? String(err)}`);
    }
  }
  return message;
}
