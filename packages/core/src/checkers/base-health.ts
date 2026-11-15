// src/checkers/base-health.ts — evidence of a failing pre-PLAN check of origin/main (#2339).
// A FAIL that never reached a verdict (timeout, environment exit 78, missing command, no exit code) is
// `inconclusive`, never red. Every entry carries a bounded, redacted tail.

// The strict CI lookup rides with base health on the internal surface (#3186).
export { fetchRequiredChecksVerdict, type RequiredChecksVerdict } from '../utils/required-checks.js';
import { describeInconclusive, type InconclusiveCause } from './inconclusive.js';

/** One base checker FAIL, as quoted in the result and the released message. */
export interface BaseHealthEvidence {
  checker: string;
  /** Set when the FAIL never reached a verdict. A timed-out compile also carries 'timeout' while it stays red on
   *  its CI-gated path (#3186); every other entry with a cause is inconclusive. */
  cause?: InconclusiveCause;
  /** The command, passed through redactSecrets. */
  command?: string;
  /** The command's exit code; absent when it had none (timeout kill, signal, spawn failure). */
  exitCode?: number;
  timeoutSeconds?: number;
  /** Tail of the checker's FAIL details, at most 500 chars (+1 for the ellipsis), passed through redactSecrets. */
  tail: string;
}

/** One line per FAIL, e.g. tests: timeout after 300s — `bash scripts/verify.sh --no-e2e`: <tail>. */
function renderBaseHealthEvidence(e: BaseHealthEvidence): string {
  const what = e.cause
    ? describeInconclusive(e.cause, e.exitCode, e.timeoutSeconds)
    : e.exitCode !== undefined
      ? `exit ${e.exitCode}`
      : 'failed';
  // Split/trim/join, not a regex: `\s*\n\s*` backtracks polynomially on long runs of whitespace in uncontrolled output.
  const tail = e.tail
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join(' | ');
  return `${e.checker}: ${what}${e.command ? ` — \`${e.command}\`` : ''}${tail ? `: ${tail}` : ''}`;
}

/** Every evidence entry on one line, `; `-separated — the text the lane-paused event, base hold and status quote. */
export function describeBaseHealthEvidence(evidence: readonly BaseHealthEvidence[]): string {
  return evidence.map(renderBaseHealthEvidence).join('; ');
}
