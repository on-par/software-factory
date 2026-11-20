import type { CheckPhaseResult } from '../phases/check.js';
import type { CiReworkReentry } from './ci-rework-round.js';
import { recordCiReworkRound } from './ci-rework-rounds.js';
import type { RunPorts } from './run-issue.js';

export interface CiReworkResume {
  prNumber: number;
  used: number;
}

export async function enterCiReworkResume(
  resume: CiReworkResume,
  branch: string,
  ports: Pick<RunPorts, 'recordRunState' | 'events'>,
): Promise<CheckPhaseResult> {
  const pr = `PR #${resume.prNumber} (${branch})`;
  ports.events('check')('check', `resuming at CI rework on ${pr} — PLAN, BUILD and the first CHECK skipped`);
  if (resume.used > 0) await recordCiReworkRound(ports, { round: resume.used, reentry: resume });
  return { passed: true, summary: { failures: 0, passes: 0, skips: 0, total: 0, results: [] }, reworkRounds: 0 };
}

export const ciReworkRoundLimit = (resume: CiReworkResume | undefined, cap: number): number =>
  resume ? Math.min(cap, resume.used + 1) : cap;

export const resumeReentry = (resume: CiReworkResume | undefined): { reentry?: CiReworkReentry } =>
  resume ? { reentry: { prNumber: resume.prNumber, previousHeadSha: undefined } } : {};

export const reworkStopSuffix = (kind: string, rounds: number, cap: number): string =>
  rounds < cap
    ? ` — this resume ran its one ${kind} rework round (${rounds} of ${cap})`
    : ` — ${kind} rework budget exhausted after ${rounds} round${rounds === 1 ? '' : 's'}`;
