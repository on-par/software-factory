// packages/core/src/utils/escalation.ts — the ESCALATE: line predicate, split out of utils/index.ts

/**
 * Shared escalation predicate. An output escalates iff some line begins with `ESCALATE:`.
 * Line-start semantics (stricter): a mid-paragraph mention of ESCALATE: in prose does NOT count.
 * Used by both production phases and the eval scorer so evals match production behavior.
 */
export function isEscalation(output: string): boolean {
  return output.split('\n').some((line) => line.startsWith('ESCALATE:'));
}

/** The first `ESCALATE:`-prefixed line, or undefined when the output is not an escalation. */
export function escalationLine(output: string): string | undefined {
  return output.split('\n').find((line) => line.startsWith('ESCALATE:'));
}
