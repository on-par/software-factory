// src/hosted/runner.ts — Fake local runner orchestrator for hosted-exec (#898,
// parent #895/#897). Drives register -> poll -> heartbeat -> complete using
// only HostedJobStore methods; no clock, no I/O, no Docker, no real agent.
import type { HostedJobResult } from '@on-par/contracts';

import type { HostedJobStore, StoredRunner } from './store.js';

export interface FakeRunnerConfig {
  runnerId: string;
  capabilities: string[];
  leaseId: string;
  ttlMs: number;
  heartbeatIntervalMs: number;
  /** Number of heartbeats to emit during fake no-op work (default 1). */
  heartbeats?: number;
  /** Force a failure result instead of completion (default false). */
  fail?: boolean;
}

export interface FakeRunnerOutcome {
  runner: StoredRunner;
  leased: boolean;
  jobId?: string;
  result?: HostedJobResult;
  trace: string;
}

export function runFakeRunner(store: HostedJobStore, config: FakeRunnerConfig): FakeRunnerOutcome {
  store.registerRunner({ runnerId: config.runnerId, capabilities: config.capabilities });

  const poll = store.pollForLease({
    runnerId: config.runnerId,
    capabilities: config.capabilities,
    leaseId: config.leaseId,
    ttlMs: config.ttlMs,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
  });

  if (!poll.ok) {
    const runner = store.getRunner(config.runnerId);
    if (!runner) {
      throw new Error(`hosted runner disappeared after registration: ${config.runnerId}`);
    }
    return { runner, leased: false, trace: 'no compatible job to lease' };
  }

  const jobId = poll.job.request.jobId;
  const heartbeats = config.heartbeats ?? 1;
  for (let i = 0; i < heartbeats; i += 1) {
    store.heartbeat(jobId, config.leaseId);
  }

  const finalized = config.fail
    ? store.fail(jobId, config.leaseId, 'fake runner reported failure')
    : store.complete(jobId, config.leaseId, 'fake runner completed no-op work');

  const result = finalized.ok ? (finalized.job.result ?? undefined) : undefined;
  const runner = store.getRunner(config.runnerId);
  if (!runner) {
    throw new Error(`hosted runner disappeared after registration: ${config.runnerId}`);
  }

  return {
    runner,
    leased: true,
    jobId,
    result,
    trace: `registered -> leased ${jobId} -> ${heartbeats} heartbeats -> ${config.fail ? 'failed' : 'completed'}`,
  };
}
