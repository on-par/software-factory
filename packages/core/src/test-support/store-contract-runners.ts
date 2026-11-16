import { expect, it } from 'vitest';

import type { CreateHostedJobInput, HostedJobStore, HostedJobStoreOptions } from '../hosted/store.js';

export function baseJobInput(overrides: Partial<CreateHostedJobInput> = {}): CreateHostedJobInput {
  return {
    jobId: 'job-1',
    repoSlug: 'on-par/software-factory',
    taskPayload: 'run the build',
    requiredCapabilities: ['git', 'node'],
    requiredAuthority: 'repo:write',
    ...overrides,
  };
}

export function leaseInput(jobId: string, runnerId: string, leaseId: string) {
  return { jobId, runnerId, leaseId, ttlMs: 60_000, heartbeatIntervalMs: 5_000 };
}

export function pollInput(runnerId: string, leaseId: string) {
  return { runnerId, capabilities: ['git', 'node'], leaseId, ttlMs: 60_000, heartbeatIntervalMs: 5_000 };
}

export function describeHostedRunnerContractCases(makeStore: (options: HostedJobStoreOptions) => HostedJobStore): void {
  it('registers runners and reads them back, refreshing heartbeat (AC#1 registry)', () => {
    let clock = 1_000;
    const store = makeStore({ now: () => clock });

    const registered = store.registerRunner({ runnerId: 'runner-1', capabilities: ['git', 'node'] });
    expect(registered).toEqual({
      runnerId: 'runner-1',
      capabilities: ['git', 'node'],
      lastHeartbeatAt: new Date(1_000).toISOString(),
      available: true,
    });
    expect(store.getRunner('runner-1')).toEqual(registered);
    expect(store.listRunners()).toEqual([registered]);

    clock = 2_000;
    const heartbeat = store.runnerHeartbeat('runner-1');
    expect(heartbeat?.lastHeartbeatAt).toBe(new Date(2_000).toISOString());

    expect(store.runnerHeartbeat('missing-runner')).toBeUndefined();
  });

  it('polls only for a capability-compatible job and prevents a second active lease (AC#2 poll)', () => {
    const store = makeStore({ now: () => 1_000 });
    store.create(baseJobInput({ jobId: 'job-needs-docker', requiredCapabilities: ['docker'] }));
    store.create(baseJobInput({ jobId: 'job-needs-git', requiredCapabilities: ['git'] }));
    store.registerRunner({ runnerId: 'runner-1', capabilities: ['git', 'node'] });

    const poll = store.pollForLease(pollInput('runner-1', 'lease-1'));
    expect(poll.ok).toBe(true);
    if (poll.ok) {
      expect(poll.job.request.jobId).toBe('job-needs-git');
      expect(poll.job.events.some((e) => e.type === 'leased')).toBe(true);
    }
    expect(store.getRunner('runner-1')?.available).toBe(false);

    const second = store.pollForLease(pollInput('runner-1', 'lease-2'));
    expect(second).toEqual({ ok: false, reason: 'no-match' });
  });

  it('records a structured result and releases the lease on complete/fail (AC#3 result + release)', () => {
    const store = makeStore({ now: () => 1_000 });
    store.create(baseJobInput());
    store.acquireLease(leaseInput('job-1', 'runner-1', 'lease-1'));

    const completed = store.complete('job-1', 'lease-1', 'done summary');
    expect(completed.ok).toBe(true);
    if (completed.ok) {
      expect(completed.job.result).toMatchObject({
        jobId: 'job-1',
        outcome: 'completed',
        summary: 'done summary',
      });
      expect(completed.job.lease).toBeNull();
    }

    store.create(baseJobInput({ jobId: 'job-2' }));
    store.acquireLease(leaseInput('job-2', 'runner-2', 'lease-2'));
    const failed = store.fail('job-2', 'lease-2', 'boom');
    expect(failed.ok).toBe(true);
    if (failed.ok) {
      expect(failed.job.result).toMatchObject({ jobId: 'job-2', outcome: 'failed', summary: 'boom' });
      expect(failed.job.lease).toBeNull();
    }
  });

  it('complete retains exitCode, logsTail, and artifacts from an optional detail (#902)', () => {
    const store = makeStore({ now: () => 1_000 });
    store.create(baseJobInput());
    store.acquireLease(leaseInput('job-1', 'runner-1', 'lease-1'));

    const artifacts = [{ name: 'build.log', ref: '/artifacts/job-1/build.log', kind: 'log' }];
    const completed = store.complete('job-1', 'lease-1', 'done summary', {
      exitCode: 0,
      logsTail: 'tail of logs',
      artifacts,
    });
    expect(completed.ok).toBe(true);
    if (completed.ok) {
      expect(completed.job.result).toMatchObject({
        outcome: 'completed',
        exitCode: 0,
        logsTail: 'tail of logs',
        artifacts,
      });
    }
  });

  it('fail retains failurePhase, exitCode, and logsTail from an optional detail (#902)', () => {
    const store = makeStore({ now: () => 1_000 });
    store.create(baseJobInput());
    store.acquireLease(leaseInput('job-1', 'runner-1', 'lease-1'));

    const failed = store.fail('job-1', 'lease-1', 'boom', {
      failurePhase: 'run',
      exitCode: 2,
      logsTail: 'tail of logs',
    });
    expect(failed.ok).toBe(true);
    if (failed.ok) {
      expect(failed.job.result).toMatchObject({
        outcome: 'failed',
        failurePhase: 'run',
        exitCode: 2,
        logsTail: 'tail of logs',
      });
    }
  });

  it('flips the lease-holder runner back to available on a terminal transition', () => {
    const store = makeStore({ now: () => 1_000 });
    store.create(baseJobInput());
    store.registerRunner({ runnerId: 'runner-1', capabilities: ['git', 'node'] });
    const poll = store.pollForLease(pollInput('runner-1', 'lease-1'));
    expect(poll.ok).toBe(true);
    expect(store.getRunner('runner-1')?.available).toBe(false);

    store.complete('job-1', 'lease-1');
    expect(store.getRunner('runner-1')?.available).toBe(true);
  });

  it('reclaims an expired lease back to requested and makes it leaseable again (AC#5 reclaim)', () => {
    let clock = 1_000;
    const store = makeStore({ now: () => clock });
    store.create(baseJobInput());
    store.registerRunner({ runnerId: 'runner-1', capabilities: ['git', 'node'] });
    store.pollForLease({
      runnerId: 'runner-1',
      capabilities: ['git', 'node'],
      leaseId: 'lease-1',
      ttlMs: 1_000,
      heartbeatIntervalMs: 500,
    });

    clock += 2_000;

    const reclaimed = store.reclaimExpired();
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]?.request.status).toBe('requested');
    expect(reclaimed[0]?.lease).toBeNull();
    expect(reclaimed[0]?.events.some((e) => e.type === 'expired' && e.severity === 'warn')).toBe(true);
    expect(store.getRunner('runner-1')?.available).toBe(true);

    store.registerRunner({ runnerId: 'runner-2', capabilities: ['git', 'node'] });
    const repoll = store.pollForLease(pollInput('runner-2', 'lease-2'));
    expect(repoll.ok).toBe(true);
  });

  it('leaves a still-valid or terminal lease untouched by reclaimExpired', () => {
    const store = makeStore({ now: () => 1_000 });
    store.create(baseJobInput());
    store.create(baseJobInput({ jobId: 'job-2' }));
    store.acquireLease(leaseInput('job-1', 'r', 'lease-1'));
    store.acquireLease(leaseInput('job-2', 'r2', 'lease-2'));
    store.complete('job-2', 'lease-2');

    expect(store.reclaimExpired()).toEqual([]);
    expect(store.get('job-1')?.request.status).toBe('leased');
    expect(store.get('job-2')?.request.status).toBe('done');
  });

  it('records cleanup proof as a lease-free "cleaned" event on a known job', () => {
    const store = makeStore({ now: () => 1_000 });
    store.create(baseJobInput());
    store.acquireLease(leaseInput('job-1', 'r', 'lease-1'));
    store.complete('job-1', 'lease-1');

    const result = store.recordCleanup('job-1', 'docker rm -f sf-job-job-1 ok');
    expect(result.ok).toBe(true);
    const job = store.get('job-1');
    expect(job?.events.at(-1)).toEqual({
      jobId: 'job-1',
      type: 'cleaned',
      ts: new Date(1_000).toISOString(),
      severity: 'info',
      message: 'cleanup proof: docker rm -f sf-job-job-1 ok',
    });
  });

  it('returns job-not-found for recordCleanup on an unknown job', () => {
    const store = makeStore({ now: () => 1_000 });
    expect(store.recordCleanup('missing', 'evidence')).toEqual({ ok: false, reason: 'job-not-found' });
  });

  it('cancels a leased job: canceled terminal status, canceled outcome, released lease, canceled event (#903)', () => {
    const store = makeStore({ now: () => 1_000 });
    store.create(baseJobInput());
    store.registerRunner({ runnerId: 'r', capabilities: ['git', 'node'] });
    store.acquireLease(leaseInput('job-1', 'r', 'lease-1'));

    const result = store.cancel('job-1', 'operator request');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.alreadyTerminal).toBe(false);
      expect(result.job.request.status).toBe('canceled');
      expect(result.job.lease).toBeNull();
      expect(result.job.result).toMatchObject({ outcome: 'canceled', summary: 'operator request' });
      expect(result.job.events.at(-1)).toMatchObject({
        type: 'canceled',
        severity: 'warn',
        message: 'hosted job canceled: operator request',
      });
    }
    expect(store.getRunner('r')?.available).toBe(true);
  });

  it('cancel is idempotent and does not overwrite the canceled result; a stale lease holder cannot finalize after cancel (#903)', () => {
    const store = makeStore({ now: () => 1_000 });
    store.create(baseJobInput());
    store.acquireLease(leaseInput('job-1', 'r', 'lease-1'));
    store.cancel('job-1', 'first cancel');

    const secondCancel = store.cancel('job-1', 'second cancel');
    expect(secondCancel).toMatchObject({ ok: true, alreadyTerminal: true });

    const staleComplete = store.complete('job-1', 'lease-1', 'late completion');
    expect(staleComplete).toMatchObject({ ok: true, alreadyTerminal: true });

    const staleFail = store.fail('job-1', 'lease-1', 'late failure');
    expect(staleFail).toMatchObject({ ok: true, alreadyTerminal: true });

    const staleHeartbeat = store.heartbeat('job-1', 'lease-1');
    expect(staleHeartbeat).toMatchObject({ ok: true, alreadyTerminal: true });

    expect(store.get('job-1')?.result).toMatchObject({ outcome: 'canceled', summary: 'first cancel' });
  });

  it('cancel on an unknown job returns job-not-found (#903)', () => {
    const store = makeStore({ now: () => 1_000 });
    expect(store.cancel('missing', 'reason')).toEqual({ ok: false, reason: 'job-not-found' });
  });

  it('reclaimJob voids a live lease back to requested, frees the runner, and appends a watchdog event (#903)', () => {
    const store = makeStore({ now: () => 1_000 });
    store.create(baseJobInput());
    store.registerRunner({ runnerId: 'r', capabilities: ['git', 'node'] });
    store.acquireLease(leaseInput('job-1', 'r', 'lease-1'));

    const result = store.reclaimJob('job-1', 'runner heartbeat stale');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.job.request.status).toBe('requested');
      expect(result.job.lease).toBeNull();
      expect(result.job.events.at(-1)).toMatchObject({
        type: 'watchdog',
        severity: 'warn',
        message: 'reclaimed for relaunch: runner heartbeat stale',
      });
    }
    expect(store.getRunner('r')?.available).toBe(true);
  });

  it('reclaimJob returns not-leased, job-terminal, and job-not-found for the corresponding cases (#903)', () => {
    const store = makeStore({ now: () => 1_000 });
    store.create(baseJobInput());
    store.create(baseJobInput({ jobId: 'job-2' }));
    store.acquireLease(leaseInput('job-2', 'r', 'lease-2'));
    store.complete('job-2', 'lease-2');

    expect(store.reclaimJob('job-1', 'reason')).toEqual({ ok: false, reason: 'not-leased' });
    expect(store.reclaimJob('job-2', 'reason')).toEqual({ ok: false, reason: 'job-terminal' });
    expect(store.reclaimJob('missing', 'reason')).toEqual({ ok: false, reason: 'job-not-found' });
  });
}
