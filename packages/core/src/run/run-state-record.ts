// src/run/run-state-record.ts — RunStateUpdate builders and the swallow-and-log writer runIssue uses (#3194)

import type { EventKind } from '../events/kinds.js';
import type { CheckerOutput, CheckSummary } from '../types/index.js';
import type { RunOutcome } from './outcome.js';
import { terminalRunStatus, type RunStateUpdate } from './state.js';

/** Writes one update. A rejection is logged as `run_state_failed` and swallowed:
 *  the run state is an observability side channel, never a run invariant. */
export async function safeRecordRunState(
  record: ((update: RunStateUpdate) => void | Promise<void>) | undefined,
  log: (type: EventKind, msg: string) => void,
  update: RunStateUpdate,
): Promise<void> {
  try {
    await record?.(update);
  } catch (err) {
    log(
      'run_state_failed',
      `run state write failed for '${update.status}': ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function failingResults(summary: CheckSummary | undefined): CheckerOutput[] {
  return summary?.results.filter((r) => r.result === 'FAIL') ?? [];
}

/** The terminal update for a returned outcome; `failures` only when the run parked. */
export function terminalRunStateUpdate(outcome: RunOutcome, summary: CheckSummary | undefined): RunStateUpdate {
  const status = terminalRunStatus(outcome);
  const failures = failingResults(summary);
  return {
    status,
    ...(outcome.branch === undefined ? {} : { branch: outcome.branch }),
    ...(outcome.route === undefined ? {} : { route: outcome.route }),
    ...(typeof outcome.reworkRounds === 'number' ? { attempts: 1 + outcome.reworkRounds } : {}),
    ...('prNumber' in outcome && outcome.prNumber !== undefined ? { prNumber: outcome.prNumber } : {}),
    ...(status === 'parked' && failures.length > 0 ? { failures } : {}),
  };
}

/** The terminal update when `runIssueOnce` threw: a decompose signal is an escalation, anything else a failure. */
export function thrownRunStateUpdate(
  decompose: boolean,
  branch: string,
  summary: CheckSummary | undefined,
): RunStateUpdate {
  const failures = failingResults(summary);
  return {
    status: decompose ? 'escalated' : 'failed',
    branch,
    ...(decompose || failures.length === 0 ? {} : { failures }),
  };
}
