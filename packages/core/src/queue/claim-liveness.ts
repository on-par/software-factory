// packages/core/src/queue/claim-liveness.ts — The one claim-liveness verdict shared by the reaper, worktree GC and the lane-file guard (#3442).

import {
  CLAIM_EXPIRES_LABEL_PREFIX,
  CLAIMED_BY_LABEL_PREFIX,
  IN_PROGRESS_LABEL,
  parseClaimExpiresLabel,
} from './github-queue.js';

/** An issue's claim verdict from its labels and the clock. `no-lease` (a claim label with no
 *  lease label) carries no expiry evidence, so it is never releasable (ADR-0104/0105). */
export type ClaimLiveness =
  | { verdict: 'live' }
  | { verdict: 'expired'; label: string; expiresAt: number }
  | { verdict: 'no-lease' }
  | { verdict: 'unclaimed' };

export function claimLiveness(labels: readonly string[], nowMs: number): ClaimLiveness {
  const nowSeconds = Math.floor(nowMs / 1000);
  const leases = labels.filter((name) => name.startsWith(CLAIM_EXPIRES_LABEL_PREFIX));
  if (leases.length > 0) {
    for (const label of leases) {
      const expiresAt = parseClaimExpiresLabel(label);
      // A malformed or still-live lease means somebody may still be working this issue.
      if (expiresAt === null || expiresAt > nowSeconds) return { verdict: 'live' };
    }
    const first = leases[0];
    return { verdict: 'expired', label: first, expiresAt: parseClaimExpiresLabel(first) ?? 0 };
  }
  if (labels.includes(IN_PROGRESS_LABEL) || labels.some((name) => name.startsWith(CLAIMED_BY_LABEL_PREFIX))) {
    return { verdict: 'no-lease' };
  }
  return { verdict: 'unclaimed' };
}

/** True for `live` and `no-lease`. Every caller treats both as "someone may still be working". */
export function claimIsLive(liveness: ClaimLiveness): boolean {
  return liveness.verdict === 'live' || liveness.verdict === 'no-lease';
}
