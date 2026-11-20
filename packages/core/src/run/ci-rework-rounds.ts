import type { IssueRunState } from '../types/index.js';
import type { RunPorts } from './run-issue.js';

export interface CiReworkRoundsUsage {
  used: number;
  cap: number;
}

export async function recordCiReworkRound(
  _ports: Pick<RunPorts, 'recordRunState' | 'events'>,
  _plan: { round: number; reentry: { prNumber: number } },
): Promise<void> {}

export function ciReworkRoundsFor(
  _state: Pick<IssueRunState, 'ciReworkRounds'> | null | undefined,
  _prNumber: number,
  _env: NodeJS.ProcessEnv = process.env,
): CiReworkRoundsUsage {
  return { used: -1, cap: -1 };
}
