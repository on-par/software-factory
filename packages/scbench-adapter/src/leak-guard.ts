// packages/scbench-adapter/src/leak-guard.ts — generic rendered-text leak guard for hidden evaluation.json identifiers (#1250).

/** Hidden values that must never appear in a rendered brief: retained
 *  evaluation.json test names and problem ids that were not deliberately
 *  surfaced by the template. */
export interface LeakGuardHiddenValues {
  testNames: string[];
  problemIds: string[];
}

/** Scan rendered brief text for any of the given hidden test names or
 *  problem ids; returns the ones actually found (substring match), or []
 *  when the text is clean. Generic over the caller's rendered text and
 *  hidden-value list so it is reusable across brief types (and any future
 *  rendered-text leak guard in this package). */
export function findLeakedValues(rendered: string, hidden: LeakGuardHiddenValues): string[] {
  return [...hidden.testNames, ...hidden.problemIds].filter((value) => rendered.includes(value));
}
