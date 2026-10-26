// packages/cli/src/cli/doctor-queue-reconcile.ts — `doctor --reconcile` queue steps: stale claims (#999) and blocked parks (#2318)

import type { Octokit } from '@octokit/rest';
import { createLogger } from '@on-par/factory-core';
import {
  createOctokitBlockedParkStore,
  createOctokitQueueClient,
  isFleetLeader,
  resolveFactoryHostId,
} from '@on-par/factory-core/internal';

import { formatClaimReconcileReport } from './doctor-health.js';
import type { CliDeps } from './index.js';

type QueueOps = Required<Pick<CliDeps, 'releaseStaleClaims' | 'pollBlockedParks'>>;

const errMessage = (err: any): string => err?.message ?? String(err);

/** Never throws: each step prints its own failure line. */
export async function reconcileQueue(
  ops: QueueOps,
  ghRepo: string | undefined,
  octokit: Octokit | undefined,
  eventsFile: string,
  maxClockSkewMs?: number,
  fleetLeader?: string,
): Promise<void> {
  const [owner, repo] = ghRepo?.split('/') ?? [];
  // Stale claim reap (#999): factory:in-progress claims naming a dead local pid go back to
  // factory:queued so the next run can claim them with no manual label surgery.
  try {
    if (ghRepo && octokit) {
      const released = await ops.releaseStaleClaims({
        client: createOctokitQueueClient(octokit),
        owner,
        repo,
        maxClockSkewMs,
      });
      console.log(formatClaimReconcileReport(released));
    } else {
      console.log('reconcile: skipping stale claims: no GitHub repo or token');
    }
  } catch (err: any) {
    console.log(`reconcile: stale claim release failed: ${errMessage(err)}`);
  }

  // Blocked-park poll (#2318): parents parked `blocked` resume once their blockers close.
  const hostId = resolveFactoryHostId();
  try {
    if (!isFleetLeader(fleetLeader, hostId)) {
      console.log(`reconcile: skipping blocked parks: this host (${hostId}) is not fleet.leader (${fleetLeader})`);
    } else if (ghRepo && octokit) {
      const results = await ops.pollBlockedParks({
        client: createOctokitQueueClient(octokit),
        owner,
        repo,
        store: createOctokitBlockedParkStore(octokit, ghRepo),
        fleetLeader,
        hostId,
        logEvent: (kind, issue, msg) => {
          const log = createLogger(eventsFile, { issue }, { out: { write: () => true } });
          if (kind === 'warn') log.warn('warn', msg);
          else if (kind === 'order_collision_repaired') log.warn('order_collision_repaired', msg);
          else log.info('issue_unparked', msg);
        },
      });
      const count = (o: string): number => results.filter((r) => r.outcome === o).length;
      console.log(
        `reconcile: blocked parks: ${count('unparked')} unparked, ${count('held')} held, ${count('capped')} capped, ${count('waiting')} waiting`,
      );
      for (const r of results) {
        if (r.outcome === 'waiting' || r.outcome === 'skipped') continue;
        console.log(`reconcile:   #${r.issue} ${r.outcome}${r.detail ? ` — ${r.detail}` : ''}`);
      }
    } else {
      console.log('reconcile: skipping blocked parks: no GitHub repo or token');
    }
  } catch (err: any) {
    console.log(`reconcile: blocked park poll failed: ${errMessage(err)}`);
  }
}
