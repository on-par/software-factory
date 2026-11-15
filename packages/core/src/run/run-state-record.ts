import type { EventKind } from '../events/kinds.js';
import type { CheckerOutput, CheckSummary } from '../types/index.js';
import type { RunOutcome } from './outcome.js';
import { terminalRunStatus, type RunStateUpdate } from './state.js';

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

export function terminalRunStateUpdate(outcome: RunOutcome, summary: CheckSummary | undefined): RunStateUpdate {
  const status = terminalRunStatus(outcome);
  const failures = failingResults(summary);
  return {
    status,
    ...(outcome.branch === undefined ? {} : { branch: outcome.branch }),
    ...(outcome.route === undefined ? {} : { route: outcome.route }),
    ...(typeof outcome.reworkRounds === 'number' ? { attempts: 1 + outcome.reworkRounds } : {}),
    ...('prNumber' in outcome && outcome.prNumber !== undefined ? { prNumber: outcome.prNumber } : {}),
    ...(outcome.state === 'ready' && outcome.draftReason ? { draftReason: outcome.draftReason } : {}),
    ...(status === 'parked' && failures.length > 0 ? { failures } : {}),
  };
}

export function thrownRunStateUpdate(branch: string, summary: CheckSummary | undefined): RunStateUpdate {
  const failures = failingResults(summary);
  return {
    status: 'failed',
    branch,
    ...(failures.length === 0 ? {} : { failures }),
  };
}
