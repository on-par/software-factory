// packages/core/src/run/budget.ts — per-issue budget enforcement (#3316)

import type { EventKind } from '../events/kinds.js';
import { upsertWorktreeKeep } from '../utils/worktree-keeps.js';

export const BUDGET_KEEP_REASON = 'budget_exceeded';

/** Returns the park message when `spend` exceeds `cap`, else undefined. An over-budget park
 *  also records a keep for the worktree so GC leaves the nearly finished work alone. */
export function enforceIssueBudget(input: {
  phase: string;
  spend: number;
  cap: number | undefined;
  issue: number;
  worktreePath: string;
  keepsFile?: string;
  log: (type: EventKind, msg: string) => void;
  now?: () => Date;
}): string | undefined {
  const { phase, spend, cap, issue, worktreePath, keepsFile, log, now } = input;
  if (cap === undefined || spend <= cap) return undefined;
  const message = `per-issue budget exceeded after ${phase}: $${spend.toFixed(2)} > $${cap.toFixed(2)}`;
  log('budget_exceeded', message);
  if (keepsFile) {
    try {
      upsertWorktreeKeep(keepsFile, {
        issue,
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
