// packages/core/src/queue/claim-release.ts — ownership-safe release and the reaper's re-read release (#3240).

import { claimLiveness } from './claim-liveness.js';
import { addQueuedOnRelease } from './release-queued.js';
import { QUEUE_ORDER_LABEL_PREFIX } from './queue-order.js';
import {
  CLAIMED_BY_LABEL_PREFIX,
  CLAIM_EXPIRES_LABEL_PREFIX,
  claimedByLabel,
  IN_PROGRESS_LABEL,
  PARKED_LABEL,
  QUEUED_LABEL,
  queueLabelSpecs,
  type QueueGitHubClient,
  type QueueReleaseOutcome,
  type StaleReleaseOutcome,
} from './github-queue.js';

export interface ClaimReleaser {
  release(issue: number, outcome?: QueueReleaseOutcome): Promise<void>;
  releaseStale(issue: number, staleLabels: readonly string[]): Promise<StaleReleaseOutcome>;
}

export function createClaimReleaser(
  client: QueueGitHubClient,
  owner: string,
  repo: string,
  claimantId: string,
  now: () => number,
): ClaimReleaser {
  const myLabel = claimedByLabel(claimantId);

  async function addParked(issue: number): Promise<void> {
    const spec = queueLabelSpecs('release', claimantId).find((s) => s.name === PARKED_LABEL);
    if (spec) await client.ensureLabel({ owner, repo, ...spec });
    await client.addLabels({ owner, repo, issue_number: issue, labels: [PARKED_LABEL] });
  }

  async function release(issue: number, outcome: QueueReleaseOutcome = 'queued'): Promise<void> {
    const current = await client.getIssueLabels({ owner, repo, issue_number: issue });
    const others = current.filter((name) => name.startsWith(CLAIMED_BY_LABEL_PREFIX) && name !== myLabel);
    if (others.length > 0) {
      if (current.includes(myLabel)) await client.removeLabel({ owner, repo, issue_number: issue, name: myLabel });
      return;
    }
    const toRemove = current.filter(
      (name) =>
        name === IN_PROGRESS_LABEL ||
        name.startsWith(CLAIMED_BY_LABEL_PREFIX) ||
        name.startsWith(CLAIM_EXPIRES_LABEL_PREFIX) ||
        (outcome !== 'queued' && (name === QUEUED_LABEL || name.startsWith(QUEUE_ORDER_LABEL_PREFIX))),
    );
    if (outcome === 'parked' && !current.includes(PARKED_LABEL)) {
      await addParked(issue).catch(() => addParked(issue)); // one retry; a second failure rejects before any claim label is removed (#3424)
    }
    for (const name of toRemove) {
      await client.removeLabel({ owner, repo, issue_number: issue, name });
    }

    if (outcome === 'done') return;

    if (outcome === 'queued') return addQueuedOnRelease(client, owner, repo, issue, current);
  }

  async function releaseStale(issue: number, staleLabels: readonly string[]): Promise<StaleReleaseOutcome> {
    const fresh = await client.getIssueLabels({ owner, repo, issue_number: issue });
    if (claimLiveness(fresh, now()).verdict !== 'expired') return 'renewed';
    const toRemove = fresh.filter(
      (name) =>
        name === IN_PROGRESS_LABEL ||
        name.startsWith(CLAIM_EXPIRES_LABEL_PREFIX) ||
        (name.startsWith(CLAIMED_BY_LABEL_PREFIX) && staleLabels.includes(name)),
    );
    for (const name of toRemove) {
      await client.removeLabel({ owner, repo, issue_number: issue, name });
    }
    await addQueuedOnRelease(client, owner, repo, issue, fresh);
    return 'released';
  }

  return { release, releaseStale };
}
