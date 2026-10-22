// packages/core/src/run/check-verdict.ts — one interpretation of a failed, non-environment CHECK (#3435).
import { remainingShowstoppers, type CheckPhaseResult } from '../phases/check.js';
import { maxLinesOverrideHint } from './max-lines-override.js';

export interface CheckFailureVerdict {
  reason: 'held' | 'escalate' | 'fail';
  message: string;
  checkFailure?: { failureSignature: string; failingChecks: string[] };
}

export function classifyCheckFailure(
  check: CheckPhaseResult,
  opts: { ciReworkRound?: number } = {},
): CheckFailureVerdict {
  const checkFailure =
    check.failureSignature !== undefined
      ? {
          failureSignature: check.failureSignature,
          failingChecks: check.summary.results.filter((r) => r.result === 'FAIL').map((r) => r.checker),
        }
      : undefined;
  const reason = check.crossRunStuck ? 'held' : check.stuck ? 'escalate' : 'fail';
  const message = check.crossRunStuck
    ? `issue held: identical failure signature parked this lane in a prior run too (${check.reworkRounds} rework rounds burned there, 0 here) — needs a human decision`
    : check.stuck
      ? `lane stuck after ${check.reworkRounds} rework rounds (identical failures) — escalated`
      : opts.ciReworkRound !== undefined
        ? `${check.summary.failures} check failures after CI rework round ${opts.ciReworkRound}`
        : `${check.summary.failures} check failures after ${check.reworkRounds} rework rounds`;
  const showstoppers = remainingShowstoppers(check.summary);
  const withShowstoppers =
    showstoppers.length > 0
      ? `${message}\nremaining showstoppers:\n${showstoppers.map((s) => `- ${s}`).join('\n')}`
      : message;
  const overrideHint = maxLinesOverrideHint(check.summary);
  const full = overrideHint ? `${withShowstoppers}\n${overrideHint}` : withShowstoppers;
  return { reason, message: full, ...(checkFailure ? { checkFailure } : {}) };
}
