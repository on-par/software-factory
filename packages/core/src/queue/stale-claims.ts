// packages/core/src/queue/stale-claims.ts — Release dead-pid claims back to factory:queued (#999).

import { hostname } from 'node:os';

import { defaultIsPidAlive } from '../environment/index.js';
import {
  CLAIMED_BY_LABEL_PREFIX,
  claimedByLabel,
  createGithubQueue,
  defaultClaimantId,
  IN_PROGRESS_LABEL,
  type QueueGitHubClient,
  type QueueIssue,
} from './github-queue.js';

/** One open issue whose every claimed-by label names a dead pid minted by this host. */
export interface StaleClaim {
  issue: number;
  /** The factory:claimed-by:* label that proved the claim stale. */
  label: string;
  /** The dead pid that label names. */
  pid: number;
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
  /** Defaults to `os.hostname()`. Injectable so tests can simulate a foreign host. */
  host?: string;
  /** Defaults to `defaultIsPidAlive` (signal-0 probe). */
  isPidAlive?: (pid: number) => boolean;
}

/** Returns the pid a `factory:claimed-by:` label names on this host, or `null` when the label
 *  wasn't minted by this host (wrong prefix, malformed suffix, or the slug/pid round-trip through
 *  `defaultClaimantId` + `claimedByLabel` doesn't reproduce the observed label byte-for-byte). */
export function localClaimPid(label: string, host: string): number | null {
  if (!label.startsWith(CLAIMED_BY_LABEL_PREFIX)) return null;

  const match = /-(\d+)$/.exec(label.slice(CLAIMED_BY_LABEL_PREFIX.length));
  if (!match) return null;

  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;

  return claimedByLabel(defaultClaimantId(host, pid)) === label ? pid : null;
}

export function findStaleClaims(
  issues: readonly QueueIssue[],
  opts: { host?: string; isPidAlive?: (pid: number) => boolean } = {},
): StaleClaim[] {
  const host = opts.host ?? hostname();
  const isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;
  const stale: StaleClaim[] = [];

  for (const issue of issues) {
    const claimLabels = issue.labels.filter((name) => name.startsWith(CLAIMED_BY_LABEL_PREFIX));
    // No claim label ⇒ no pid evidence ⇒ never releasable (#999 out of scope: other claim states).
    if (claimLabels.length === 0) continue;

    let deadest: StaleClaim | null = null;
    let allDeadLocal = true;
    for (const label of claimLabels) {
      const pid = localClaimPid(label, host);
      // A foreign-host label or a live pid means somebody may still be working this issue.
      if (pid === null || isPidAlive(pid)) {
        allDeadLocal = false;
        break;
      }
      deadest ??= { issue: issue.number, label, pid };
    }
    if (allDeadLocal && deadest) stale.push(deadest);
  }

  return stale;
}

export async function releaseStaleClaims(opts: ReleaseStaleClaimsOptions): Promise<StaleClaimRelease[]> {
  const { client, owner, repo } = opts;
  const claimed = await client.listOpenIssuesWithLabels({ owner, repo, labels: [IN_PROGRESS_LABEL] });
  const stale = findStaleClaims(claimed, { host: opts.host, isPidAlive: opts.isPidAlive });
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
