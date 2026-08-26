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
});
