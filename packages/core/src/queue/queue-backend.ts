// packages/core/src/queue/queue-backend.ts — Backend-agnostic queue seam; GitHub-labels is today's only implementation (#1499).

import {
  createGithubQueue,
  type GithubQueueOptions,
  type QueueClaim,
  type QueueReleaseOutcome,
} from './github-queue.js';
import { releaseStaleClaims, type StaleClaimRelease } from './stale-claims.js';

export interface QueueBackend {
  /** Claims and returns the next eligible issue in `lane`, or null when none is eligible. */
  claimNext(lane: string): Promise<QueueClaim | null>;
  /** Releases a previously claimed issue back to the queue with the given outcome (default 'queued'). */
  release(issue: number, outcome?: QueueReleaseOutcome): Promise<void>;
  /** Queued issue numbers for one lane, in claim order; every lane, lane-sorted, when `lane` is omitted. */
  list(lane?: string): Promise<number[]>;
  /** Detects and releases claims whose TTL lease has expired across the whole queue. */
  reap(): Promise<StaleClaimRelease[]>;
}

export type GithubQueueBackendOptions = GithubQueueOptions;

export function createGithubQueueBackend(options: GithubQueueBackendOptions): QueueBackend {
  const { client, owner, repo, now } = options;
  const queue = createGithubQueue(options);

  async function list(lane?: string): Promise<number[]> {
    if (lane !== undefined) return queue.list(lane);
    const issues: number[] = [];
    for (const l of await queue.lanes()) {
      issues.push(...(await queue.list(l)));
    }
    return issues;
  }

  async function reap(): Promise<StaleClaimRelease[]> {
    return releaseStaleClaims({ client, owner, repo, now });
  }

  return { claimNext: queue.claimNext, release: queue.release, list, reap };
}
