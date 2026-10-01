// Sequencing and summary for `run-issue --run-children` (#1747, #1748).

/** One decomposed child's outcome. `ready` means its PR is open and ready for review. */
export interface ChildRunResult {
  issue: number;
  status: 'ready' | 'failed' | 'not-run' | 'skipped' | 'decomposed';
  prNumber?: number;
  /** Failure detail for `failed`; the skip reason for `skipped`; why it did not start for `not-run`. */
  detail?: string;
  /** Child issues filed when this child was itself decomposed (`decomposed` only). */
  children?: number[];
}

const STOP_DETAIL = '.factory/STOP present';

/** Runs children strictly one at a time in the given (build) order. A child that decomposes again
 *  is replaced in place by its fresh children, which run before the remaining siblings; issues in
 *  the seen set (`alreadySeen`, the initial children, anything already expanded) never run twice.
 *  A `skipped` or `failed` child does not stop the sequence: failures are recorded and the next
 *  child still runs. A `runChild` that throws is recorded as `failed` with the error message.
 *  `shouldStop` is consulted before each child starts; once it returns true that child and every
 *  later one are marked `not-run` and never run. A child already running is never interrupted. */
export async function runChildrenInOrder(
  children: readonly number[],
  runChild: (issue: number) => Promise<ChildRunResult>,
  alreadySeen: Iterable<number> = [],
  shouldStop: (nextIssue: number) => boolean = () => false,
): Promise<ChildRunResult[]> {
  const queue = [...children];
  const seen = new Set<number>([...alreadySeen, ...children]);
  const results: ChildRunResult[] = [];
  let stopped = false;
  for (let i = 0; i < queue.length; i++) {
    const issue = queue[i];
    if (!stopped && shouldStop(issue)) stopped = true;
    if (stopped) {
      results.push({ issue, status: 'not-run', detail: STOP_DETAIL });
      continue;
    }
    let result: ChildRunResult;
    try {
      result = await runChild(issue);
    } catch (err) {
      result = { issue, status: 'failed', detail: err instanceof Error ? err.message : String(err) };
    }
    results.push(result);
    if (result.status === 'decomposed') {
      const fresh = (result.children ?? []).filter((n) => !seen.has(n));
      for (const n of fresh) seen.add(n);
      queue.splice(i + 1, 0, ...fresh);
    }
  }
  return results;
}

/** True when every child that ran reached ready-for-review, was skipped as closed, or was
 *  replaced by its own children. */
export function childRunSucceeded(results: readonly ChildRunResult[]): boolean {
  return results.every((r) => r.status === 'ready' || r.status === 'skipped' || r.status === 'decomposed');
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
    } else if (r.status === 'skipped') {
      lines.push(r.detail ? `  #${r.issue} → skipped: ${r.detail}` : `  #${r.issue} → skipped`);
    } else if (r.status === 'decomposed') {
      lines.push(`  #${r.issue} → decomposed into ${(r.children ?? []).map((n) => `#${n}`).join(', ')}`);
    } else {
      lines.push(r.detail ? `  #${r.issue} → not run: ${r.detail}` : `  #${r.issue} → not run`);
    }
  }
  const leaf = results.filter((r) => r.status !== 'decomposed');
  const ready = leaf.filter((r) => r.status === 'ready').length;
  const skipped = leaf.filter((r) => r.status === 'skipped').length;
  lines.push(`${ready}/${leaf.length} children ready for review${skipped > 0 ? `, ${skipped} skipped` : ''}`);
  return lines;
}
