import type { IssueRunState } from '../types/index.js';
import { resolveMaxCiReworkRounds } from './ci-rework.js';
import type { RunPorts } from './run-issue.js';
import { safeRecordRunState } from './run-state-record.js';

export interface CiReworkRoundsUsage {
  used: number;
  cap: number;
}

export async function recordCiReworkRound(
  ports: Pick<RunPorts, 'recordRunState' | 'events'>,
  plan: { round: number; reentry: { prNumber: number } },
): Promise<void> {
  await safeRecordRunState(ports.recordRunState, ports.events(), {
    status: 'shipping',
    ciReworkRound: { prNumber: plan.reentry.prNumber, round: plan.round },
  });
}

export function ciReworkRoundsFor(
  state: Pick<IssueRunState, 'ciReworkRounds'> | null | undefined,
  prNumber: number,
  env: NodeJS.ProcessEnv = process.env,
): CiReworkRoundsUsage {
  const used = state?.ciReworkRounds?.[String(prNumber)];
  return {
    used: typeof used === 'number' && Number.isSafeInteger(used) && used >= 0 ? used : 0,
    cap: resolveMaxCiReworkRounds(env),
  };
}
