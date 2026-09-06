// packages/scbench-adapter/src/all-groups-pass.ts — shared all-groups pass/fail predicate (#1254).
import type { ScbenchEvaluation } from './baseline.js';

/** True iff every test group present in pass_counts or total_counts has
 *  pass === total (a missing key on either side counts as 0). A group with
 *  total 0 vacuously passes. */
export function allGroupsPass(evaluation: ScbenchEvaluation): boolean {
  const groups = new Set([...Object.keys(evaluation.pass_counts), ...Object.keys(evaluation.total_counts)]);
  for (const group of groups) {
    if ((evaluation.pass_counts[group] ?? 0) < (evaluation.total_counts[group] ?? 0)) {
      return false;
    }
  }
  return true;
}
