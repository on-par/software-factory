export { fetchRequiredChecksVerdict, type RequiredChecksVerdict } from '../utils/required-checks.js';
import { describeInconclusive, type InconclusiveCause } from './inconclusive.js';

export interface BaseHealthEvidence {
  checker: string;
  cause?: InconclusiveCause;
  command?: string;
  exitCode?: number;
  timeoutSeconds?: number;
  tail: string;
}

function renderBaseHealthEvidence(e: BaseHealthEvidence): string {
  const what = e.cause
    ? describeInconclusive(e.cause, e.exitCode, e.timeoutSeconds)
    : e.exitCode !== undefined
      ? `exit ${e.exitCode}`
      : 'failed';
  const tail = e.tail
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join(' | ');
  return `${e.checker}: ${what}${e.command ? ` — \`${e.command}\`` : ''}${tail ? `: ${tail}` : ''}`;
}

export function describeBaseHealthEvidence(evidence: readonly BaseHealthEvidence[]): string {
  return evidence.map(renderBaseHealthEvidence).join('; ');
}
