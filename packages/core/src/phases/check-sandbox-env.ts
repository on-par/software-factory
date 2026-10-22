import { sandboxEnvFailure } from '../environment/sandbox-env.js';
import type { CheckSummary } from '../types/index.js';
import type { CheckPhaseResult } from './check.js';

/** The CHECK stop for a verify.sh sandbox marker (#3332): no baseline and no further rework; undefined when no checker carries one. */
export function sandboxEnvStop(
  summary: CheckSummary,
  reworkRounds: number,
  failureSignature: string,
  log: (kind: 'check', message: string) => void,
): CheckPhaseResult | undefined {
  const line = sandboxEnvFailure(summary.results);
  if (!line) return undefined;
  log('check', `sandbox environment error (${line}) — skipping baseline and rework`);
  return { passed: false, summary, reworkRounds, failureSignature, sandboxEnv: line };
}
