// packages/core/src/queue/claim-label-sweep.ts — Delete lease labels no open issue carries (#1623).

import { CLAIM_EXPIRES_LABEL_PREFIX, CLAIMED_BY_LABEL_PREFIX, type QueueGitHubClient } from './github-queue.js';

export const DEFAULT_MAX_LABEL_DELETES_PER_SWEEP = 200;

export interface OrphanClaimLabelSweep {
  /** False when the client lacks listRepoLabels/deleteRepoLabel/listAllOpenIssues; nothing was read or deleted. */
  ran: boolean;
  deleted: string[];
  /** Lease labels kept because an open issue carries them. */
  inUse: string[];
  /** Orphans left for the next sweep because maxDeletes was reached. */
  remaining: number;
  /** Delete calls that threw (name + message); the sweep continues past them. */
  failed: Array<{ name: string; detail: string }>;
}

export async function sweepOrphanClaimLabels(opts: {
  client: QueueGitHubClient;
  owner: string;
  repo: string;
  maxDeletes?: number;
}): Promise<OrphanClaimLabelSweep> {
  const { client, owner, repo } = opts;
  const { listRepoLabels, deleteRepoLabel, listAllOpenIssues } = client;
  const result: OrphanClaimLabelSweep = { ran: false, deleted: [], inUse: [], remaining: 0, failed: [] };
  if (!listRepoLabels || !deleteRepoLabel || !listAllOpenIssues) return result;
  result.ran = true;

  const candidates = (await listRepoLabels.call(client, { owner, repo })).filter(
    (n) => n.startsWith(CLAIM_EXPIRES_LABEL_PREFIX) || n.startsWith(CLAIMED_BY_LABEL_PREFIX),
  );
  if (candidates.length === 0) return result;

  // Issues are read after labels so a label minted between the reads and already attached counts as in use.
  const inUseSet = new Set((await listAllOpenIssues.call(client, { owner, repo })).flatMap((i) => i.labels));
  const orphans = candidates.filter((n) => !inUseSet.has(n)).sort();
  result.inUse = candidates.filter((n) => inUseSet.has(n));

  const batch = orphans.slice(0, opts.maxDeletes ?? DEFAULT_MAX_LABEL_DELETES_PER_SWEEP);
  for (const name of batch) {
    try {
      await deleteRepoLabel.call(client, { owner, repo, name });
      result.deleted.push(name);
    } catch (err) {
      result.failed.push({ name, detail: err instanceof Error ? err.message : String(err) });
    }
  }
  result.remaining = orphans.length - batch.length;
  return result;
}
