// Sequencing and summary for `run-issue --run-children` (#1747).

/** One decomposed child's outcome. `ready` means its PR is open and ready for review. */
export interface ChildRunResult {
  issue: number;
  status: 'ready' | 'failed' | 'not-run';
  prNumber?: number;
  /** Failure detail for `failed`; unused otherwise. */
  detail?: string;
}

/** Runs children strictly one at a time in the given (build) order. Stops at the first child
 *  that is not `ready` and marks the rest `not-run`. A `runChild` that throws is recorded as
 *  `failed` with the error message. */
export async function runChildrenInOrder(
  children: readonly number[],
  runChild: (issue: number) => Promise<ChildRunResult>,
): Promise<ChildRunResult[]> {
  const results: ChildRunResult[] = [];
  let stopped = false;
  for (const issue of children) {
    if (stopped) {
      results.push({ issue, status: 'not-run' });
      continue;
    }
    let result: ChildRunResult;
    try {
      result = await runChild(issue);
    } catch (err) {
      result = { issue, status: 'failed', detail: err instanceof Error ? err.message : String(err) };
    }
    results.push(result);
    if (result.status !== 'ready') stopped = true;
  }
  return results;
}

/** Renders the per-child summary lines; the caller colours and prints them. */
export function formatChildRunSummary(parent: number, results: readonly ChildRunResult[]): string[] {
  const lines = [`Children of #${parent}:`];
  for (const r of results) {
    if (r.status === 'ready') {
      lines.push(
        r.prNumber !== undefined
          ? `  #${r.issue} → PR #${r.prNumber} ready for review`
          : `  #${r.issue} → ready (no PR number)`,
      );
    } else if (r.status === 'failed') {
      lines.push(r.detail ? `  #${r.issue} → failed: ${r.detail}` : `  #${r.issue} → failed`);
    } else {
      lines.push(`  #${r.issue} → not run`);
    }
  }
  const ready = results.filter((r) => r.status === 'ready').length;
  lines.push(`${ready}/${results.length} children ready for review`);
  return lines;
}
