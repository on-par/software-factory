// packages/core/src/queue/stale-claims.ts — Release expired-lease claims back to factory:queued (#1500).

import { claimLiveness } from './claim-liveness.js';
import { createGithubQueue, IN_PROGRESS_LABEL, type QueueGitHubClient, type QueueIssue } from './github-queue.js';

/** One open issue whose claim lease has expired. */
export interface StaleClaim {
  issue: number;
  /** The factory:claim-expires:* label that proved the claim stale. */
  label: string;
  /** The lease expiry (epoch seconds) that label names. */
  expiresAt: number;
}

/** The result of attempting to put one stale claim back in the queue. */
export interface StaleClaimRelease extends StaleClaim {
  /** False when the release call threw; `detail` then carries the error message. */
  released: boolean;
  detail?: string;
}

export interface ReleaseStaleClaimsOptions {
  client: QueueGitHubClient;
  owner: string;
  repo: string;
  /** Defaults to `Date.now`. Injectable so tests can simulate elapsed time. */
  now?: () => number;
}

export function findStaleClaims(issues: readonly QueueIssue[], opts: { now?: () => number } = {}): StaleClaim[] {
  const nowMs = (opts.now ?? Date.now)();
  const stale: StaleClaim[] = [];

  for (const issue of issues) {
    const liveness = claimLiveness(issue.labels, nowMs);
    if (liveness.verdict === 'expired') {
      stale.push({ issue: issue.number, label: liveness.label, expiresAt: liveness.expiresAt });
    }
  }

  return stale;
}

export async function releaseStaleClaims(opts: ReleaseStaleClaimsOptions): Promise<StaleClaimRelease[]> {
  const { client, owner, repo } = opts;
  const claimed = await client.listOpenIssuesWithLabels({ owner, repo, labels: [IN_PROGRESS_LABEL] });
  const stale = findStaleClaims(claimed, { now: opts.now });
  if (stale.length === 0) return [];

  const queue = createGithubQueue({ client, owner, repo });
  const results: StaleClaimRelease[] = [];
  for (const claim of stale) {
    try {
      await queue.release(claim.issue, 'queued');
      results.push({ ...claim, released: true });
    } catch (err) {
      results.push({ ...claim, released: false, detail: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}
