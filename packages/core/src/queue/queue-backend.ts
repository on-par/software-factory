// packages/core/src/queue/queue-backend.ts — Backend-agnostic queue seam speaking WorkKey; GitHub-labels is today's only implementation (#1499, #3890).

import { type BlockedParkPollResult, type BlockedParkStore, pollBlockedParks } from '../blockers/poller.js';
import {
  createGithubQueue,
  type GithubQueueOptions,
  type QueueClaim,
  type QueueReleaseOutcome,
} from './github-queue.js';
import { issueNumberOf, workKeyFromIssue, type WorkKey } from '../work/work-key.js';
import { createLinearQueueBackend, type LinearQueueBackendOptions } from './linear-queue-backend.js';
import type { LinearStaleClaimRelease } from './linear-queue-lifecycle.js';
import { releaseStaleClaims, type StaleClaimRelease } from './stale-claims.js';

export interface QueueBackendClaim {
  key: WorkKey;
  decision: QueueClaim['decision'];
}

export type QueueBackendReapRow = StaleClaimRelease | LinearStaleClaimRelease;

export interface QueueBackend {
  /** Claims and returns the next eligible work item in `lane`, or null when none is eligible. */
  claimNext(lane: string): Promise<QueueBackendClaim | null>;
  /** Releases a previously claimed work item back to the queue with the given outcome (default 'queued'). */
  release(key: WorkKey, outcome?: QueueReleaseOutcome): Promise<void>;
  /** Refreshes this claimant's lease; false when the claim is gone (GithubQueue.heartbeat semantics). */
  heartbeat(key: WorkKey): Promise<boolean>;
  /** Queued work keys for one lane, in claim order; every lane, lane-sorted, when `lane` is omitted. */
  list(lane?: string): Promise<WorkKey[]>;
  /** The first queued work item of `lane` and its `factory:order` position, used to rank waiting lanes (#3958); absent on backends without order labels. */
  laneHead?(lane: string): Promise<{ key: WorkKey; position: number | null } | null>;
  /** Lane names that currently have queued work. */
  lanes(): Promise<string[]>;
  /** Detects and releases claims whose TTL lease has expired across the whole queue. */
  reap(): Promise<QueueBackendReapRow[]>;
  /** Unparks `blocked` parents whose blockers resolved (#2318); [] when no blockedParks store was configured. */
  pollBlockedParks(): Promise<BlockedParkPollResult[]>;
}

export type GithubQueueBackendOptions = GithubQueueOptions & { blockedParks?: BlockedParkStore };

export function createGithubQueueBackend(options: GithubQueueBackendOptions): QueueBackend {
  const { client, owner, repo, now } = options;
  const queue = createGithubQueue(options);

  async function claimNext(lane: string): Promise<QueueBackendClaim | null> {
    const claim = await queue.claimNext(lane);
    return claim === null ? null : { key: workKeyFromIssue(claim.issue), decision: claim.decision };
  }

  async function list(lane?: string): Promise<WorkKey[]> {
    if (lane !== undefined) return (await queue.list(lane)).map(workKeyFromIssue);
    const keys: WorkKey[] = [];
    for (const l of await queue.lanes()) {
      keys.push(...(await queue.list(l)).map(workKeyFromIssue));
    }
    return keys;
  }

  async function laneHead(lane: string): Promise<{ key: WorkKey; position: number | null } | null> {
    const first = await queue.head(lane);
    return first === null ? null : { key: workKeyFromIssue(first.issue), position: first.position };
  }

  async function reap(): Promise<StaleClaimRelease[]> {
    return releaseStaleClaims({ client, owner, repo, now });
  }

  async function pollParks(): Promise<BlockedParkPollResult[]> {
    if (options.blockedParks === undefined) return [];
    return pollBlockedParks({ client, owner, repo, store: options.blockedParks });
  }

  return {
    claimNext,
    release: async (key, outcome) => queue.release(issueNumberOf(key), outcome),
    heartbeat: async (key) => queue.heartbeat(issueNumberOf(key)),
    list,
    laneHead,
    lanes: () => queue.lanes(),
    reap,
    pollBlockedParks: pollParks,
  };
}

export type QueueBackendKind = 'github' | 'linear';

export type QueueBackendOptions =
  { kind: 'github'; github: GithubQueueBackendOptions } | { kind: 'linear'; linear: LinearQueueBackendOptions };

export class UnsupportedQueueBackendError extends Error {
  readonly kind: string;

  constructor(kind: string) {
    super(`unsupported queue backend "${kind}" — supported: github, linear`);
    this.name = 'UnsupportedQueueBackendError';
    this.kind = kind;
  }
}

export function createQueueBackend(options: QueueBackendOptions): QueueBackend {
  switch (options.kind) {
    case 'github':
      return createGithubQueueBackend(options.github);
    case 'linear':
      return createLinearQueueBackend(options.linear);
    default: {
      const unknownOptions: { kind: unknown } = options;
      throw new UnsupportedQueueBackendError(String(unknownOptions.kind));
    }
  }
}
