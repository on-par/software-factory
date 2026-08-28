// src/hosted/watchdog.ts — Control-plane reliability sweep for hosted-exec
// (#903, parent #895/#897/#898). Pure module, no clock/IO of its own beyond
// the injected policy.now: folds in lease-expiry recovery (retryable),
// enforces a hard runtime cap (fail-per-policy), safely relaunches jobs
// whose runner has gone dead without duplicating active work, and escalates
// stuck active runs it cannot safely fix.
import type { HostedJobEvent, HostedJobStatus } from '@on-par/contracts';

import type { HostedJobStore } from './store.js';

export interface WatchdogPolicy {
  /** ms clock, injected for determinism. */
  now: () => number;
  /** A lease-holding runner is "dead" if its lastHeartbeatAt is older than this. */
  runnerHeartbeatTimeoutMs: number;
  /** Hard cap on a single lease's runtime. */
  maxJobRuntimeMs: number;
  /** Max 'leased' events before a dead-runner job escalates instead of relaunching. */
  maxRelaunches: number;
  /** Events included in an escalation's recentEvents tail. Default 5. */
  recentEventLimit?: number;
}

export interface WatchdogEscalation {
  jobId: string;
  status: HostedJobStatus;
  reason: string;
  recentEvents: HostedJobEvent[];
  manualIntervention: string;
}

export interface WatchdogReport {
  /** ISO-8601 of policy.now(). */
  sweptAt: string;
  /** jobIds returned to retryable via lease expiry. */
  reclaimedExpired: string[];
  /** jobIds force-reclaimed due to a dead runner. */
  relaunchedDeadRunners: string[];
  /** jobIds failed for exceeding maxJobRuntimeMs. */
  timedOut: string[];
  /** Stuck runs the watchdog cannot safely fix. */
  escalations: WatchdogEscalation[];
}

function leasedAtMs(job: ReturnType<HostedJobStore['list']>[number]): number {
  const lastLeased = [...job.events].reverse().find((event) => event.type === 'leased');
  return lastLeased ? Date.parse(lastLeased.ts) : Date.parse(job.updatedAt);
}

function leaseCount(job: ReturnType<HostedJobStore['list']>[number]): number {
  return job.events.filter((event) => event.type === 'leased').length;
}

/** Runs one reliability sweep over every non-terminal job in the store,
 * classifying each into reclaimed-expired / relaunched-dead-runner /
 * timed-out / escalation. */
export function runWatchdogSweep(store: HostedJobStore, policy: WatchdogPolicy): WatchdogReport {
  const reclaimedExpired = store.reclaimExpired().map((job) => job.request.jobId);

  const relaunchedDeadRunners: string[] = [];
  const timedOut: string[] = [];
  const escalations: WatchdogEscalation[] = [];
  const recentEventLimit = policy.recentEventLimit ?? 5;

  for (const job of store.list()) {
    if (job.lease === null) {
      continue;
    }
    const runtimeMs = policy.now() - leasedAtMs(job);
    const runner = store.getRunner(job.lease.runnerId);
    const runnerDead = !runner || policy.now() - Date.parse(runner.lastHeartbeatAt) > policy.runnerHeartbeatTimeoutMs;

    if (runtimeMs > policy.maxJobRuntimeMs) {
      store.fail(job.request.jobId, job.lease.leaseId, `watchdog: exceeded max runtime ${policy.maxJobRuntimeMs}ms`, {
        failurePhase: 'run',
      });
      timedOut.push(job.request.jobId);
      continue;
    }

    if (runnerDead) {
      const count = leaseCount(job);
      if (count < policy.maxRelaunches) {
        store.reclaimJob(job.request.jobId, 'runner heartbeat stale');
        relaunchedDeadRunners.push(job.request.jobId);
      } else {
        escalations.push({
          jobId: job.request.jobId,
          status: job.request.status,
          reason: 'dead runner and relaunch budget exhausted',
          recentEvents: job.events.slice(-recentEventLimit),
          manualIntervention: `inspect .factory events for ${job.request.jobId}; cancel or manually re-lease`,
        });
      }
    }
  }

  return {
    sweptAt: new Date(policy.now()).toISOString(),
    reclaimedExpired,
    relaunchedDeadRunners,
    timedOut,
    escalations,
  };
}
