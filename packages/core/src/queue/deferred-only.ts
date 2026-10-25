// packages/core/src/queue/deferred-only.ts — Unqueue a queue that is only waiting on open prerequisites (#3660).

import {
  CLAIMED_BY_LABEL_PREFIX,
  IN_PROGRESS_LABEL,
  laneLabel,
  QUEUED_LABEL,
  type QueueGitHubClient,
} from './github-queue.js';

export interface DeferredOnlyResult {
  /** 'empty': no queued unclaimed issue in the lanes; 'mixed': at least one is not prerequisite-deferred (no writes);
   *  'deferred-only': every one was, and factory:queued was removed from each that was still queued and unclaimed. */
  verdict: 'empty' | 'mixed' | 'deferred-only';
  /** Queued, unclaimed issues in the planned lanes, ascending. */
  queued: number[];
  /** Issues that lost factory:queued, ascending. */
  unqueued: number[];
  skipped: Array<{ issue: number; reason: string }>;
}

const isClaimed = (labels: readonly string[]): boolean =>
  labels.some((l) => l === IN_PROGRESS_LABEL || l.startsWith(CLAIMED_BY_LABEL_PREFIX));

export async function unqueueDeferredOnly(opts: {
  client: QueueGitHubClient;
  owner: string;
  repo: string;
  lanes: readonly string[];
  deferred: ReadonlySet<number>;
}): Promise<DeferredOnlyResult> {
  const { client, owner, repo, deferred } = opts;
  const laneLabels = new Set(opts.lanes.map(laneLabel));
  const listed = await client.listOpenIssuesWithLabels({ owner, repo, labels: [QUEUED_LABEL] });
  const queued = listed
    .filter((i) => i.labels.some((l) => laneLabels.has(l)) && !isClaimed(i.labels))
    .map((i) => i.number)
    .sort((a, b) => a - b);
  const result: DeferredOnlyResult = { verdict: 'empty', queued, unqueued: [], skipped: [] };
  if (queued.length === 0) return result;
  if (queued.some((n) => !deferred.has(n))) return { ...result, verdict: 'mixed' };

  for (const issue of queued) {
    try {
      const labels = await client.getIssueLabels({ owner, repo, issue_number: issue });
      if (!labels.includes(QUEUED_LABEL)) {
        result.skipped.push({ issue, reason: 'no longer queued' });
      } else if (isClaimed(labels)) {
        result.skipped.push({ issue, reason: 'claimed' });
      } else {
        await client.removeLabel({ owner, repo, issue_number: issue, name: QUEUED_LABEL });
        result.unqueued.push(issue);
      }
    } catch (err: any) {
      result.skipped.push({ issue, reason: err?.message ?? String(err) });
    }
  }
  return { ...result, verdict: 'deferred-only' };
}
