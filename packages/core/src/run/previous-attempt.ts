// src/run/previous-attempt.ts — the "## Previous attempt" note for a re-dispatched issue's PLAN/BUILD prompts (#3373)

import type { IssueRunState } from '../types/index.js';
import { UNTRUSTED_CHECKER_OUTPUT_NOTICE, wrapUntrustedCheckerOutput } from '../utils/untrusted-input.js';

export const PREVIOUS_ATTEMPT_MAX_CHARS = 2000;
const DETAILS_MAX_CHARS = 400;

const CLOSING_LINE =
  'Do not repeat the approach that produced these failures. If the spec itself is the cause, print a line starting exactly with "ESCALATE:" explaining why, then stop.';

const MID_PHASE: Readonly<Record<string, string>> = {
  planning: 'PLAN',
  building: 'BUILD',
  checking: 'CHECK',
  reworking: 'rework',
  shipping: 'SHIP',
};

function runLine(prior: IssueRunState): string {
  return `(attempts: ${prior.attempts}, route: ${prior.route}, model: ${prior.model || 'unknown'})`;
}

function failureBlock(checker: string, result: string, details: string): string {
  const shown = details.slice(0, DETAILS_MAX_CHARS) + (details.length > DETAILS_MAX_CHARS ? '…' : '');
  return `- ${checker} (${result}):\n${wrapUntrustedCheckerOutput(shown)}`;
}

/** Append the closing line; as a last guard hard-slice the body (never the closing line) to the cap. */
function capNote(body: string): string {
  const tail = `\n\n${CLOSING_LINE}`;
  return body.length + tail.length <= PREVIOUS_ATTEMPT_MAX_CHARS
    ? body + tail
    : body.slice(0, PREVIOUS_ATTEMPT_MAX_CHARS - tail.length) + tail;
}

/** Pure and total: returns '' when there is nothing to say; never throws. */
export function renderPreviousAttempt(prior: IssueRunState | null | undefined): string {
  if (!prior) return '';
  const phase = MID_PHASE[prior.status];
  if (phase) {
    return capNote(
      `## Previous attempt\nThe last run of this issue stopped during ${phase} without an outcome ${runLine(prior)}.`,
    );
  }
  if (prior.status !== 'parked' && prior.status !== 'escalated' && prior.status !== 'failed') return '';

  const header = '## Previous attempt\n';
  const runText = `The last run of this issue ended ${prior.status} ${runLine(prior)}.`;
  const failures = prior.failures ?? [];
  const tail = `\n\n${CLOSING_LINE}`;
  if (failures.length === 0) return capNote(header + runText);

  const fixed = `${header}${runText}\n${UNTRUSTED_CHECKER_OUTPUT_NOTICE}\nFailing checkers:`;
  let body = '';
  let used = 0;
  for (const f of failures) {
    const block = `\n${failureBlock(f.checker, f.result, f.details ?? '')}`;
    const omitted = `\n- (${failures.length - used - 1} more failing checker(s) omitted)`;
    const isLast = used === failures.length - 1;
    if (
      fixed.length + body.length + block.length + (isLast ? 0 : omitted.length) + tail.length >
      PREVIOUS_ATTEMPT_MAX_CHARS
    )
      break;
    body += block;
    used++;
  }
  if (used < failures.length) body += `\n- (${failures.length - used} more failing checker(s) omitted)`;
  return capNote(fixed + body);
}
