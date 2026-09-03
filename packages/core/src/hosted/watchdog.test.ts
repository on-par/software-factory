import { describe, expect, it } from 'vitest';

import { runWatchdogSweep, type WatchdogPolicy } from './watchdog.js';
import { createHostedJobStore, type CreateHostedJobInput, type HostedJobStore } from './store.js';

function baseJobInput(overrides: Partial<CreateHostedJobInput> = {}): CreateHostedJobInput {
  return {
    jobId: 'job-1',
    repoSlug: 'on-par/software-factory',
    taskPayload: 'run the build',
    requiredCapabilities: ['git', 'node'],
    requiredAuthority: 'repo:write',
    ...overrides,
  };
}

function basePolicy(overrides: Partial<WatchdogPolicy> = {}, clock: () => number = () => 1_000): WatchdogPolicy {
  return {
    now: clock,
    runnerHeartbeatTimeoutMs: 30_000,
    maxJobRuntimeMs: 300_000,
    maxRelaunches: 2,
    ...overrides,
  };
}

function leaseJob(store: HostedJobStore, jobId: string, runnerId: string, leaseId: string, ttlMs = 60_000): void {
  store.registerRunner({ runnerId, capabilities: ['git', 'node'] });
  store.acquireLease({ jobId, runnerId, leaseId, ttlMs, heartbeatIntervalMs: 5_000 });
}

describe('runWatchdogSweep', () => {
  it('folds in lease-expiry recovery first, returning expired-lease jobs to retryable (#903)', () => {
    let clock = 1_000;
    const store = createHostedJobStore({ now: () => clock });
    store.create(baseJobInput());
    leaseJob(store, 'job-1', 'runner-1', 'lease-1', 1_000);

    clock += 5_000; // past the 1s TTL

    const report = runWatchdogSweep(
      store,
      basePolicy({}, () => clock),
    );

    expect(report.reclaimedExpired).toEqual(['job-1']);
    expect(store.get('job-1')?.request.status).toBe('requested');
    expect(store.getRunner('runner-1')?.available).toBe(true);
    // The old lease holder can no longer finalize — retried work is never double-finalized.
    expect(store.complete('job-1', 'lease-1')).toMatchObject({ ok: false, reason: 'lease-mismatch' });
  });

  it('relaunches a dead-runner job under the relaunch budget without duplicating work (#903)', () => {
    const clock = 1_000;
    const store = createHostedJobStore({ now: () => clock });
    store.create(baseJobInput());
    leaseJob(store, 'job-1', 'runner-1', 'lease-1');

    const report = runWatchdogSweep(
      store,
      basePolicy({ runnerHeartbeatTimeoutMs: 1, maxRelaunches: 2 }, () => clock + 10_000),
    );

    expect(report.relaunchedDeadRunners).toEqual(['job-1']);
    expect(report.escalations).toEqual([]);
    expect(store.get('job-1')?.request.status).toBe('requested');
    expect(store.get('job-1')?.lease).toBeNull();
    expect(store.getRunner('runner-1')?.available).toBe(true);
    // The old lease holder still cannot finalize after a force-reclaim.
    expect(store.complete('job-1', 'lease-1')).toMatchObject({ ok: false, reason: 'lease-mismatch' });
  });

  it('fails a job whose current-lease runtime exceeds maxJobRuntimeMs (hard-cap policy) (#903)', () => {
    const clock = 1_000;
    const store = createHostedJobStore({ now: () => clock });
    store.create(baseJobInput());
    leaseJob(store, 'job-1', 'runner-1', 'lease-1');
    store.runnerHeartbeat('runner-1'); // keep the runner alive so only the runtime cap fires

    const report = runWatchdogSweep(
      store,
      basePolicy({ maxJobRuntimeMs: 5_000 }, () => clock + 10_000),
    );

    expect(report.timedOut).toEqual(['job-1']);
    expect(report.relaunchedDeadRunners).toEqual([]);
    expect(store.get('job-1')?.request.status).toBe('failed');
    expect(store.get('job-1')?.result).toMatchObject({ outcome: 'failed' });
  });

  it('escalates a stuck dead-runner job once the relaunch budget is exhausted, distinct from relaunched (#903)', () => {
    const clock = 1_000;
    const store = createHostedJobStore({ now: () => clock });
    store.create(baseJobInput());
    store.registerRunner({ runnerId: 'runner-1', capabilities: ['git', 'node'] });

    // Simulate two prior relaunches by leasing/reclaiming twice, then a third live lease.
    store.acquireLease({
      jobId: 'job-1',
      runnerId: 'runner-1',
      leaseId: 'lease-1',
      ttlMs: 60_000,
      heartbeatIntervalMs: 5_000,
    });
    store.reclaimJob('job-1', 'runner heartbeat stale');
    store.acquireLease({
      jobId: 'job-1',
      runnerId: 'runner-1',
      leaseId: 'lease-2',
      ttlMs: 60_000,
      heartbeatIntervalMs: 5_000,
    });
    store.reclaimJob('job-1', 'runner heartbeat stale');
    store.acquireLease({
      jobId: 'job-1',
      runnerId: 'runner-1',
      leaseId: 'lease-3',
      ttlMs: 60_000,
      heartbeatIntervalMs: 5_000,
    });

    const report = runWatchdogSweep(
      store,
      basePolicy({ runnerHeartbeatTimeoutMs: 1, maxRelaunches: 2 }, () => clock + 10_000),
    );

    expect(report.relaunchedDeadRunners).toEqual([]);
    expect(report.escalations).toHaveLength(1);
    const escalation = report.escalations[0];
    expect(escalation).toMatchObject({
      jobId: 'job-1',
      reason: 'dead runner and relaunch budget exhausted',
      manualIntervention: expect.stringContaining('job-1'),
    });
    expect(escalation?.recentEvents.length).toBeGreaterThan(0);
    // relaunched and escalated sets are disjoint (auto-fixable vs escalation distinction).
    expect(report.relaunchedDeadRunners).not.toContain('job-1');
    // Still leased — the watchdog did not silently mutate an unsafe job.
    expect(store.get('job-1')?.request.status).toBe('leased');
  });

  it('leaves a healthy leased job untouched', () => {
    const clock = 1_000;
    const store = createHostedJobStore({ now: () => clock });
    store.create(baseJobInput());
    leaseJob(store, 'job-1', 'runner-1', 'lease-1');
    store.runnerHeartbeat('runner-1');

    const report = runWatchdogSweep(
      store,
      basePolicy({}, () => clock + 1_000),
    );

    expect(report).toMatchObject({
      reclaimedExpired: [],
      relaunchedDeadRunners: [],
      timedOut: [],
      escalations: [],
    });
    expect(store.get('job-1')?.request.status).toBe('leased');
  });

  it('skips terminal and unleased jobs entirely', () => {
    const clock = 1_000;
    const store = createHostedJobStore({ now: () => clock });
    store.create(baseJobInput()); // 'requested', no lease
    store.create(baseJobInput({ jobId: 'job-2' }));
    leaseJob(store, 'job-2', 'runner-1', 'lease-1');
    store.complete('job-2', 'lease-1');

    const report = runWatchdogSweep(
      store,
      basePolicy({}, () => clock + 1_000_000),
    );

    expect(report).toMatchObject({
      reclaimedExpired: [],
      relaunchedDeadRunners: [],
      timedOut: [],
      escalations: [],
    });
  });
});
