// packages/core/src/queue/linear-queue-backend.ts — Linear QueueBackend composed from the list/claim and release/park/reap halves (ADR-0173 decision 10, #3918).
import type { LinearTrackerConfig } from '../config/tracker-section.js';
import { defaultClaimantId } from './github-queue.js';
import { createLinearQueue, type LinearQueueClient } from './linear-queue.js';
import { createLinearQueueLifecycle, type LinearQueueLifecycleClient } from './linear-queue-lifecycle.js';
import type { QueueBackend } from './queue-backend.js';

export interface LinearQueueBackendOptions {
  client: LinearQueueClient & LinearQueueLifecycleClient;
  linear: LinearTrackerConfig;
  warn: (msg: string) => void;
  claimantId?: string;
  leaseMs?: number;
  now?: () => number;
  defaultLane?: string;
}

/** The one `projects` key mapped to `ghRepo` (case-insensitive); null when none, throws when several. */
export function resolveLinearProjectForRepo(linear: LinearTrackerConfig, ghRepo: string): string | null {
  const want = ghRepo.toLowerCase();
  const matches = Object.entries(linear.projects)
    .filter(([, repo]) => repo.toLowerCase() === want)
    .map(([project]) => project);
  if (matches.length > 1) {
    throw new Error(`tracker.linear.projects maps ${ghRepo} from more than one project: ${matches.join(', ')}`);
  }
  return matches[0] ?? null;
}

export function createLinearQueueBackend(options: LinearQueueBackendOptions): QueueBackend {
  const { client, linear, warn } = options;
  const claimantId = options.claimantId ?? defaultClaimantId();
  const queue = createLinearQueue({ client, linear, claimantId, defaultLane: options.defaultLane });
  const life = createLinearQueueLifecycle({
    client,
    linear,
    warn,
    claimantId,
    leaseMs: options.leaseMs,
    now: options.now,
  });
  return {
    claimNext: async (lane) => {
      const claim = await queue.claimNext(lane);
      if (claim) await life.heartbeat(claim.key);
      return claim;
    },
    release: (key, outcome) => life.release(key, outcome),
    heartbeat: life.heartbeat,
    list: queue.list,
    lanes: queue.lanes,
    reap: life.reap,
    pollBlockedParks: async () => [],
  };
}
