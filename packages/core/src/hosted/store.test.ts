import { describe, expect, it } from 'vitest';

import { createHostedJobStore, type CreateHostedJobInput } from './store.js';

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

describe('createHostedJobStore', () => {
  it('creates a job and reads it back deterministically (AC#1)', () => {
    let clock = 1_000;
    const store = createHostedJobStore({ now: () => clock });

    const created = store.create(baseJobInput());
    const expectedCreatedAt = new Date(clock).toISOString();

    expect(created.request).toEqual({
      jobId: 'job-1',
      repoSlug: 'on-par/software-factory',
      taskPayload: 'run the build',
      requiredCapabilities: ['git', 'node'],
      requiredAuthority: 'repo:write',
      status: 'requested',
      createdAt: expectedCreatedAt,
    });
    expect(created.updatedAt).toBe(expectedCreatedAt);
    expect(created.events).toEqual([
      { jobId: 'job-1', type: 'requested', ts: expectedCreatedAt, severity: 'info', message: 'hosted job requested' },
    ]);

    const fetched = store.get('job-1');
    expect(fetched).toEqual(created);
    expect(store.list()).toEqual([created]);
  });

  it('throws on a duplicate jobId', () => {
    const store = createHostedJobStore({ now: () => 1_000 });
    store.create(baseJobInput());
    expect(() => store.create(baseJobInput())).toThrow('hosted job already exists: job-1');
  });

  it('get returns undefined for an unknown job', () => {
    const store = createHostedJobStore({ now: () => 1_000 });
    expect(store.get('missing')).toBeUndefined();
  });

  it('enforces a single active lease per job (AC#2)', () => {
    const store = createHostedJobStore({ now: () => 1_000 });
    store.create(baseJobInput());

    const first = store.acquireLease({
      jobId: 'job-1',
      runnerId: 'runner-a',
      leaseId: 'lease-1',
      ttlMs: 60_000,
      heartbeatIntervalMs: 5_000,
    });
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.job.request.status).toBe('leased');
      expect(first.lease.leaseId).toBe('lease-1');
    }

    const second = store.acquireLease({
      jobId: 'job-1',
      runnerId: 'runner-b',
      leaseId: 'lease-2',
      ttlMs: 60_000,
      heartbeatIntervalMs: 5_000,
    });
    expect(second).toMatchObject({ ok: false, reason: 'lease-held' });
  });

  it('rejects acquireLease for an unknown or terminal job', () => {
    const store = createHostedJobStore({ now: () => 1_000 });
    expect(
      store.acquireLease({ jobId: 'missing', runnerId: 'r', leaseId: 'l', ttlMs: 1000, heartbeatIntervalMs: 1000 }),
    ).toMatchObject({
      ok: false,
      reason: 'job-not-found',
    });

    store.create(baseJobInput());
    store.acquireLease({ jobId: 'job-1', runnerId: 'r', leaseId: 'l1', ttlMs: 1000, heartbeatIntervalMs: 1000 });
    store.complete('job-1', 'l1');

    expect(
      store.acquireLease({ jobId: 'job-1', runnerId: 'r', leaseId: 'l2', ttlMs: 1000, heartbeatIntervalMs: 1000 }),
    ).toMatchObject({
      ok: false,
      reason: 'job-terminal',
    });
  });

  it('finalizes exactly once by the lease holder (AC#3)', () => {
    const store = createHostedJobStore({ now: () => 1_000 });
    store.create(baseJobInput());
    store.acquireLease({
      jobId: 'job-1',
      runnerId: 'r',
      leaseId: 'lease-1',
      ttlMs: 60_000,
      heartbeatIntervalMs: 5_000,
    });

    const hb = store.heartbeat('job-1', 'lease-1');
    expect(hb).toMatchObject({ ok: true, alreadyTerminal: false });
    if (hb.ok) {
      expect(hb.job.request.status).toBe('running');
    }

    const completed = store.complete('job-1', 'lease-1');
    expect(completed).toMatchObject({ ok: true, alreadyTerminal: false });
    if (completed.ok) {
      expect(completed.job.request.status).toBe('done');
      expect(completed.job.events.filter((e) => e.type === 'completed')).toHaveLength(1);
    }
  });

  it('fails a job by the lease holder with the reason recorded', () => {
    const store = createHostedJobStore({ now: () => 1_000 });
    store.create(baseJobInput({ jobId: 'job-2' }));
    store.acquireLease({
      jobId: 'job-2',
      runnerId: 'r',
      leaseId: 'lease-1',
      ttlMs: 60_000,
      heartbeatIntervalMs: 5_000,
    });

    const failed = store.fail('job-2', 'lease-1', 'runner crashed');
    expect(failed).toMatchObject({ ok: true, alreadyTerminal: false });
    if (failed.ok) {
      expect(failed.job.request.status).toBe('failed');
      const event = failed.job.events.find((e) => e.type === 'failed');
      expect(event?.message).toContain('runner crashed');
      expect(event?.severity).toBe('error');
    }
  });

  it('treats duplicate terminal updates as harmless and auditable (AC#4)', () => {
    const store = createHostedJobStore({ now: () => 1_000 });
    store.create(baseJobInput());
    store.acquireLease({
      jobId: 'job-1',
      runnerId: 'r',
      leaseId: 'lease-1',
      ttlMs: 60_000,
      heartbeatIntervalMs: 5_000,
    });
    store.complete('job-1', 'lease-1');

    const secondComplete = store.complete('job-1', 'lease-1');
    expect(secondComplete).toMatchObject({ ok: true, alreadyTerminal: true });

    const failAfterDone = store.fail('job-1', 'lease-1', 'too late');
    expect(failAfterDone).toMatchObject({ ok: true, alreadyTerminal: true });

    const heartbeatAfterDone = store.heartbeat('job-1', 'lease-1');
    expect(heartbeatAfterDone).toMatchObject({ ok: true, alreadyTerminal: true });

    if (heartbeatAfterDone.ok) {
      expect(heartbeatAfterDone.job.request.status).toBe('done');
      const auditEvents = heartbeatAfterDone.job.events.filter((e) => e.severity === 'warn');
      expect(auditEvents.length).toBeGreaterThanOrEqual(3);
      expect(auditEvents.every((e) => e.message === 'ignored: job already terminal')).toBe(true);
    }
  });

  it('rejects a mismatched-lease finalize on a non-terminal job and an unknown job', () => {
    const store = createHostedJobStore({ now: () => 1_000 });
    store.create(baseJobInput());
    store.acquireLease({
      jobId: 'job-1',
      runnerId: 'r',
      leaseId: 'lease-1',
      ttlMs: 60_000,
      heartbeatIntervalMs: 5_000,
    });

    expect(store.complete('job-1', 'wrong-lease')).toMatchObject({ ok: false, reason: 'lease-mismatch' });
    expect(store.complete('missing-job', 'lease-1')).toMatchObject({ ok: false, reason: 'job-not-found' });
  });

  it('rejects mutation by an expired lease and allows safe re-lease (AC#5)', () => {
    let clock = 1_000;
    const store = createHostedJobStore({ now: () => clock });
    store.create(baseJobInput());
    store.acquireLease({ jobId: 'job-1', runnerId: 'r', leaseId: 'lease-1', ttlMs: 1_000, heartbeatIntervalMs: 500 });

    clock += 2_000; // now past expiresAt

    expect(store.complete('job-1', 'lease-1')).toMatchObject({ ok: false, reason: 'lease-expired' });
    expect(store.fail('job-1', 'lease-1', 'x')).toMatchObject({ ok: false, reason: 'lease-expired' });
    expect(store.heartbeat('job-1', 'lease-1')).toMatchObject({ ok: false, reason: 'lease-expired' });
    expect(store.get('job-1')?.request.status).toBe('leased');

    const release = store.acquireLease({
      jobId: 'job-1',
      runnerId: 'r2',
      leaseId: 'lease-2',
      ttlMs: 60_000,
      heartbeatIntervalMs: 5_000,
    });
    expect(release.ok).toBe(true);
    if (release.ok) {
      expect(release.lease.leaseId).toBe('lease-2');
      expect(release.job.request.status).toBe('leased');
    }

    const completed = store.complete('job-1', 'lease-2');
    expect(completed).toMatchObject({ ok: true, alreadyTerminal: false });
    if (completed.ok) {
      expect(completed.job.request.status).toBe('done');
    }
  });

  it('registers runners and reads them back, refreshing heartbeat (AC#1 registry)', () => {
    let clock = 1_000;
    const store = createHostedJobStore({ now: () => clock });

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
    const store = createHostedJobStore({ now: () => 1_000 });
    store.create(baseJobInput({ jobId: 'job-needs-docker', requiredCapabilities: ['docker'] }));
    store.create(baseJobInput({ jobId: 'job-needs-git', requiredCapabilities: ['git'] }));
    store.registerRunner({ runnerId: 'runner-1', capabilities: ['git', 'node'] });

    const poll = store.pollForLease({
      runnerId: 'runner-1',
      capabilities: ['git', 'node'],
      leaseId: 'lease-1',
      ttlMs: 60_000,
      heartbeatIntervalMs: 5_000,
    });
    expect(poll.ok).toBe(true);
    if (poll.ok) {
      expect(poll.job.request.jobId).toBe('job-needs-git');
      expect(poll.job.events.some((e) => e.type === 'leased')).toBe(true);
    }
    expect(store.getRunner('runner-1')?.available).toBe(false);

    const second = store.pollForLease({
      runnerId: 'runner-1',
      capabilities: ['git', 'node'],
      leaseId: 'lease-2',
      ttlMs: 60_000,
      heartbeatIntervalMs: 5_000,
    });
    expect(second).toEqual({ ok: false, reason: 'no-match' });
  });

  it('records a structured result and releases the lease on complete/fail (AC#3 result + release)', () => {
    const store = createHostedJobStore({ now: () => 1_000 });
    store.create(baseJobInput());
    store.acquireLease({
      jobId: 'job-1',
      runnerId: 'runner-1',
      leaseId: 'lease-1',
      ttlMs: 60_000,
      heartbeatIntervalMs: 5_000,
    });

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
    store.acquireLease({
      jobId: 'job-2',
      runnerId: 'runner-2',
      leaseId: 'lease-2',
      ttlMs: 60_000,
      heartbeatIntervalMs: 5_000,
    });
    const failed = store.fail('job-2', 'lease-2', 'boom');
    expect(failed.ok).toBe(true);
    if (failed.ok) {
      expect(failed.job.result).toMatchObject({ jobId: 'job-2', outcome: 'failed', summary: 'boom' });
      expect(failed.job.lease).toBeNull();
    }
  });

  it('complete retains exitCode, logsTail, and artifacts from an optional detail (#902)', () => {
    const store = createHostedJobStore({ now: () => 1_000 });
    store.create(baseJobInput());
    store.acquireLease({
      jobId: 'job-1',
      runnerId: 'runner-1',
      leaseId: 'lease-1',
      ttlMs: 60_000,
      heartbeatIntervalMs: 5_000,
    });

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
    const store = createHostedJobStore({ now: () => 1_000 });
    store.create(baseJobInput());
    store.acquireLease({
      jobId: 'job-1',
      runnerId: 'runner-1',
      leaseId: 'lease-1',
      ttlMs: 60_000,
      heartbeatIntervalMs: 5_000,
    });

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
    const store = createHostedJobStore({ now: () => 1_000 });
    store.create(baseJobInput());
    store.registerRunner({ runnerId: 'runner-1', capabilities: ['git', 'node'] });
    const poll = store.pollForLease({
      runnerId: 'runner-1',
      capabilities: ['git', 'node'],
      leaseId: 'lease-1',
      ttlMs: 60_000,
      heartbeatIntervalMs: 5_000,
    });
    expect(poll.ok).toBe(true);
    expect(store.getRunner('runner-1')?.available).toBe(false);

    store.complete('job-1', 'lease-1');
    expect(store.getRunner('runner-1')?.available).toBe(true);
  });

  it('reclaims an expired lease back to requested and makes it leaseable again (AC#5 reclaim)', () => {
    let clock = 1_000;
    const store = createHostedJobStore({ now: () => clock });
    store.create(baseJobInput());
    store.registerRunner({ runnerId: 'runner-1', capabilities: ['git', 'node'] });
    store.pollForLease({
      runnerId: 'runner-1',
      capabilities: ['git', 'node'],
      leaseId: 'lease-1',
      ttlMs: 1_000,
      heartbeatIntervalMs: 500,
    });

    clock += 2_000; // past expiresAt

    const reclaimed = store.reclaimExpired();
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]?.request.status).toBe('requested');
    expect(reclaimed[0]?.lease).toBeNull();
    expect(reclaimed[0]?.events.some((e) => e.type === 'expired' && e.severity === 'warn')).toBe(true);
    expect(store.getRunner('runner-1')?.available).toBe(true);

    store.registerRunner({ runnerId: 'runner-2', capabilities: ['git', 'node'] });
    const repoll = store.pollForLease({
      runnerId: 'runner-2',
      capabilities: ['git', 'node'],
      leaseId: 'lease-2',
      ttlMs: 60_000,
      heartbeatIntervalMs: 5_000,
    });
    expect(repoll.ok).toBe(true);
  });

  it('leaves a still-valid or terminal lease untouched by reclaimExpired', () => {
    const store = createHostedJobStore({ now: () => 1_000 });
    store.create(baseJobInput());
    store.create(baseJobInput({ jobId: 'job-2' }));
    store.acquireLease({
      jobId: 'job-1',
      runnerId: 'r',
      leaseId: 'lease-1',
      ttlMs: 60_000,
      heartbeatIntervalMs: 5_000,
    });
    store.acquireLease({
      jobId: 'job-2',
      runnerId: 'r2',
      leaseId: 'lease-2',
      ttlMs: 60_000,
      heartbeatIntervalMs: 5_000,
    });
    store.complete('job-2', 'lease-2');

    expect(store.reclaimExpired()).toEqual([]);
    expect(store.get('job-1')?.request.status).toBe('leased');
    expect(store.get('job-2')?.request.status).toBe('done');
  });

  it('records cleanup proof as a lease-free "cleaned" event on a known job', () => {
    const store = createHostedJobStore({ now: () => 1_000 });
    store.create(baseJobInput());
    store.acquireLease({
      jobId: 'job-1',
      runnerId: 'r',
      leaseId: 'lease-1',
      ttlMs: 60_000,
      heartbeatIntervalMs: 5_000,
    });
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
    const store = createHostedJobStore({ now: () => 1_000 });
    expect(store.recordCleanup('missing', 'evidence')).toEqual({ ok: false, reason: 'job-not-found' });
  });
});
