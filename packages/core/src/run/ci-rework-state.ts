import type { IssueRunState } from '../types/index.js';
import type { WorkKey } from '../work/work-key.js';
import { resolveMaxCiReworkRounds } from './ci-rework.js';
import { readIssueRunState, runStateFile } from './state.js';

export interface CiReworkBudget {
  used: number;
  cap: number;
}

export function mergeCiReworkRounds(
  ...maps: (Readonly<Record<string, number>> | undefined)[]
): Record<string, number> | undefined {
  const merged: Record<string, number> = {};
  for (const map of maps) {
    if (typeof map !== 'object' || map === null || Array.isArray(map)) continue;
    for (const [pr, used] of Object.entries(map)) {
      if (!/^\d+$/.test(pr) || !Number.isSafeInteger(used) || used < 0) continue;
      merged[pr] = Math.max(merged[pr] ?? 0, used);
    }
  }
  return Object.keys(merged).length === 0 ? undefined : merged;
}

export function ciReworkBudget(
  state: Pick<IssueRunState, 'ciReworkRounds'> | null | undefined,
  prNumber: number,
  env: NodeJS.ProcessEnv = process.env,
): CiReworkBudget {
  return {
    used: mergeCiReworkRounds(state?.ciReworkRounds)?.[String(prNumber)] ?? 0,
    cap: resolveMaxCiReworkRounds(env),
  };
}

export async function readCiReworkBudget(
  runsDir: string,
  key: WorkKey,
  prNumber: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CiReworkBudget> {
  return ciReworkBudget(await readIssueRunState(runStateFile(runsDir, key)), prNumber, env);
}
