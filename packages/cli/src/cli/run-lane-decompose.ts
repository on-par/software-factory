// packages/cli/src/cli/run-lane-decompose.ts — writes a decomposed issue's children into the GitHub queue before the lane moves on (#3539).

import type { logEvent, GithubQueue } from '@on-par/factory-core/internal';
import { QUEUED_LABEL } from '@on-par/factory-core/internal';

import { shipRuntime } from './ship-runtime.js';

export type ChildEnqueueResult = Awaited<ReturnType<GithubQueue['enqueueAfter']>>;

/**
 * Queues `children` behind `parent` and emits a `fail` event for every child or shift that could not be written.
 * `unwritten` are the children that exist only in this lane run (all of them when the write threw); `clean` is false
 * when anything failed, so the caller does not report the decomposition as clean.
 */
export async function queueDecomposedChildren(
  queueChildren: (parent: number, children: number[]) => Promise<ChildEnqueueResult>,
  parent: number,
  children: number[],
  lane: string,
  eventsPath: string,
  emitEvent: typeof logEvent,
): Promise<{ unwritten: number[]; clean: boolean }> {
  const fail = (subject: number, message: string) => emitEvent(eventsPath, 'fail', subject, message, { lane });
  try {
    const queued = await queueChildren(parent, children);
    const failed = queued.results.filter((r) => r.outcome === 'failed');
    for (const r of failed) {
      fail(
        r.issue,
        `decomposed child #${r.issue} of #${parent} not queued: could not add label '${QUEUED_LABEL}' on lane '${lane}' (${r.detail ?? 'unknown error'}); it survives only in this lane run`,
      );
    }
    if (queued.detail !== undefined) {
      fail(
        parent,
        `decomposed children of #${parent} queued at the tail of lane '${lane}', not behind #${parent}: shifting later factory:order labels failed (${queued.detail})`,
      );
    }
    return { unwritten: failed.map((r) => r.issue), clean: failed.length === 0 && queued.detail === undefined };
  } catch (e) {
    fail(
      parent,
      `decomposed children ${children.map((n) => `#${n}`).join(', ')} of #${parent} not queued: could not add label '${QUEUED_LABEL}' on lane '${lane}' (${shipRuntime().errorDetail(e)})`,
    );
    return { unwritten: children, clean: false };
  }
}
