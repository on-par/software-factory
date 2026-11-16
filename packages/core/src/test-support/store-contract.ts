import { describe, expect, it } from 'vitest';

import type { HostedJobStore, HostedJobStoreOptions } from '../hosted/store.js';
import { baseJobInput, describeHostedRunnerContractCases, leaseInput } from './store-contract-runners.js';

export function describeHostedJobStoreContract(
  label: string,
  makeStore: (options: HostedJobStoreOptions) => HostedJobStore,
): void {
  describe(`HostedJobStore contract (${label})`, () => {
    it('creates a job and reads it back deterministically (AC#1)', () => {
      const clock = 1_000;
      const store = makeStore({ now: () => clock });

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
      const store = makeStore({ now: () => 1_000 });
      store.create(baseJobInput());
      expect(() => store.create(baseJobInput())).toThrow('hosted job already exists: job-1');
    });

    it('get returns undefined for an unknown job', () => {
      const store = makeStore({ now: () => 1_000 });
      expect(store.get('missing')).toBeUndefined();
    });

    it('enforces a single active lease per job (AC#2)', () => {
      const store = makeStore({ now: () => 1_000 });
      store.create(baseJobInput());

      const first = store.acquireLease(leaseInput('job-1', 'runner-a', 'lease-1'));
      expect(first.ok).toBe(true);
      if (first.ok) {
        expect(first.job.request.status).toBe('leased');
        expect(first.lease.leaseId).toBe('lease-1');
      }

      const second = store.acquireLease(leaseInput('job-1', 'runner-b', 'lease-2'));
      expect(second).toMatchObject({ ok: false, reason: 'lease-held' });
    });

    it('rejects acquireLease for an unknown or terminal job', () => {
      const store = makeStore({ now: () => 1_000 });
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
      const store = makeStore({ now: () => 1_000 });
      store.create(baseJobInput());
      store.acquireLease(leaseInput('job-1', 'r', 'lease-1'));

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
      const store = makeStore({ now: () => 1_000 });
      store.create(baseJobInput({ jobId: 'job-2' }));
      store.acquireLease(leaseInput('job-2', 'r', 'lease-1'));

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
      const store = makeStore({ now: () => 1_000 });
      store.create(baseJobInput());
      store.acquireLease(leaseInput('job-1', 'r', 'lease-1'));
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
      const store = makeStore({ now: () => 1_000 });
      store.create(baseJobInput());
      store.acquireLease(leaseInput('job-1', 'r', 'lease-1'));

      expect(store.complete('job-1', 'wrong-lease')).toMatchObject({ ok: false, reason: 'lease-mismatch' });
      expect(store.complete('missing-job', 'lease-1')).toMatchObject({ ok: false, reason: 'job-not-found' });
      const job = store.get('job-1');
      expect(job?.result).toBeNull();
      expect(job?.events.at(-1)).toMatchObject({
        type: 'expired',
        severity: 'warn',
        message: 'ignored: stale finalize attempt (lease not held)',
      });
    });

    it('rejects mutation by an expired lease and allows safe re-lease (AC#5)', () => {
      let clock = 1_000;
      const store = makeStore({ now: () => clock });
      store.create(baseJobInput());
      store.acquireLease({ jobId: 'job-1', runnerId: 'r', leaseId: 'lease-1', ttlMs: 1_000, heartbeatIntervalMs: 500 });

      clock += 2_000;

      expect(store.complete('job-1', 'lease-1')).toMatchObject({ ok: false, reason: 'lease-expired' });
      expect(store.fail('job-1', 'lease-1', 'x')).toMatchObject({ ok: false, reason: 'lease-expired' });
      expect(store.heartbeat('job-1', 'lease-1')).toMatchObject({ ok: false, reason: 'lease-expired' });
      expect(store.get('job-1')?.request.status).toBe('leased');
      expect(store.get('job-1')?.result).toBeNull();
      expect(
        store
          .get('job-1')
          ?.events.filter(
            (event) =>
              event.type === 'expired' &&
              event.severity === 'warn' &&
              event.message === 'ignored: stale finalize attempt (lease expired)',
          ),
      ).toHaveLength(2);

      const release = store.acquireLease(leaseInput('job-1', 'r2', 'lease-2'));
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

    it('logs an expired lease finalize attempt after the job was reclaimed', () => {
      let clock = 1_000;
      const store = makeStore({ now: () => clock });
      store.create(baseJobInput());
      store.acquireLease({ jobId: 'job-1', runnerId: 'r', leaseId: 'lease-1', ttlMs: 1_000, heartbeatIntervalMs: 500 });

      clock += 2_000;
      const reclaimed = store.reclaimExpired();
      expect(reclaimed).toHaveLength(1);
      expect(store.get('job-1')?.request.status).toBe('requested');
      expect(store.get('job-1')?.lease).toBeNull();

      const staleComplete = store.complete('job-1', 'lease-1');

      expect(staleComplete).toMatchObject({ ok: false, reason: 'lease-mismatch' });
      expect(store.get('job-1')?.request.status).toBe('requested');
      expect(store.get('job-1')?.result).toBeNull();
      expect(store.get('job-1')?.events.at(-1)).toMatchObject({
        type: 'expired',
        severity: 'warn',
        message: 'ignored: stale finalize attempt (lease not held)',
      });
    });

    describeHostedRunnerContractCases(makeStore);
  });
}
