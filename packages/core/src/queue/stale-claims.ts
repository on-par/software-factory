// packages/core/src/queue/stale-claims.ts — Release expired-lease claims back to factory:queued (#1500).

import {
  CLAIM_EXPIRES_LABEL_PREFIX,
  createGithubQueue,
  IN_PROGRESS_LABEL,
  parseClaimExpiresLabel,
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
  const now = opts.now ?? Date.now;
  const nowSeconds = Math.floor(now() / 1000);
  const stale: StaleClaim[] = [];

  for (const issue of issues) {
    const expiresLabels = issue.labels.filter((name) => name.startsWith(CLAIM_EXPIRES_LABEL_PREFIX));
    // No lease label ⇒ no expiry evidence ⇒ never releasable (#999 out of scope: other claim states).
    if (expiresLabels.length === 0) continue;

    let expired: StaleClaim | null = null;
    for (const label of expiresLabels) {
      const expiresAt = parseClaimExpiresLabel(label);
      // A malformed or still-live lease means somebody may still be working this issue.
      if (expiresAt === null || expiresAt > nowSeconds) {
        expired = null;
        break;
      }
      expired ??= { issue: issue.number, label, expiresAt };
    }
    if (expired) stale.push(expired);
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
