// packages/core/src/queue/stale-claims.ts — Release expired-lease claims back to factory:queued (#1500); every run also sweeps orphaned lease labels (#1623).

import { sweepOrphanClaimLabels, type OrphanClaimLabelSweep } from './claim-label-sweep.js';
import { claimLiveness } from './claim-liveness.js';
import {
  CLAIMED_BY_LABEL_PREFIX,
  createGithubQueue,
  IN_PROGRESS_LABEL,
  type QueueGitHubClient,
  type QueueIssue,
} from './github-queue.js';

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
  /** True only when `outcome` is 'released'. */
  released: boolean;
  /** 'renewed': the fresh read no longer showed an expired lease, so nothing was written (#3240).
   *  'failed': the release call threw; `detail` then carries the error message. */
  outcome: 'released' | 'renewed' | 'failed';
  detail?: string;
}

export interface ReleaseStaleClaimsOptions {
  client: QueueGitHubClient;
  owner: string;
  repo: string;
  /** Defaults to `Date.now`. Injectable so tests can simulate elapsed time. */
  now?: () => number;
  /** Called after the orphan lease-label sweep (#1623). */
  onLabelSweep?: (sweep: OrphanClaimLabelSweep) => void;
  /** Called when the orphan lease-label sweep throws; the sweep never fails the run (#1623). */
  onLabelSweepError?: (err: unknown) => void;
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
  const results = stale.length === 0 ? [] : await releaseAll(opts, claimed, stale);
  try {
    const sweep = await sweepOrphanClaimLabels({ client, owner, repo });
    opts.onLabelSweep?.(sweep);
  } catch (err) {
    opts.onLabelSweepError?.(err);
  }
  return results;
}

async function releaseAll(
  opts: ReleaseStaleClaimsOptions,
  claimed: readonly QueueIssue[],
  stale: readonly StaleClaim[],
): Promise<StaleClaimRelease[]> {
  const { client, owner, repo } = opts;
  const labelsByIssue = new Map(claimed.map((i) => [i.number, i.labels]));
  const queue = createGithubQueue({ client, owner, repo, now: opts.now });
  const results: StaleClaimRelease[] = [];
  for (const claim of stale) {
    try {
      const staleLabels = (labelsByIssue.get(claim.issue) ?? []).filter((n) => n.startsWith(CLAIMED_BY_LABEL_PREFIX));
      const outcome = await queue.releaseStale(claim.issue, staleLabels);
      results.push({ ...claim, released: outcome === 'released', outcome });
    } catch (err) {
      results.push({
        ...claim,
        released: false,
        outcome: 'failed',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}
