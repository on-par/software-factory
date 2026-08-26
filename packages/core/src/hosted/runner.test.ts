import { describe, expect, it } from 'vitest';

import { createHostedJobStore, type CreateHostedJobInput } from './store.js';
import { runFakeRunner } from './runner.js';

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

describe('runFakeRunner', () => {
  it('registers, leases, heartbeats, and completes a compatible job', () => {
    const store = createHostedJobStore({ now: () => 1_000 });
    store.create(baseJobInput());

    const outcome = runFakeRunner(store, {
      runnerId: 'runner-1',
      capabilities: ['git', 'node'],
      leaseId: 'lease-1',
      ttlMs: 60_000,
      heartbeatIntervalMs: 5_000,
    });

    expect(outcome.leased).toBe(true);
    expect(outcome.jobId).toBe('job-1');
    expect(outcome.result).toMatchObject({ jobId: 'job-1', outcome: 'completed' });
    expect(outcome.runner.available).toBe(true);
    expect(outcome.trace).toBe('registered -> leased job-1 -> 1 heartbeats -> completed');

    const job = store.get('job-1');
    expect(job?.request.status).toBe('done');
    expect(job?.lease).toBeNull();
    expect(job?.events.filter((e) => e.type === 'heartbeat')).toHaveLength(1);
  });

  it('returns leased:false and leaves the job requested when no capability match exists', () => {
    const store = createHostedJobStore({ now: () => 1_000 });
    store.create(baseJobInput({ requiredCapabilities: ['docker'] }));

    const outcome = runFakeRunner(store, {
      runnerId: 'runner-1',
      capabilities: ['git', 'node'],
      leaseId: 'lease-1',
      ttlMs: 60_000,
      heartbeatIntervalMs: 5_000,
    });

    expect(outcome.leased).toBe(false);
    expect(outcome.jobId).toBeUndefined();
    expect(outcome.result).toBeUndefined();
    expect(outcome.trace).toBe('no compatible job to lease');
    expect(store.get('job-1')?.request.status).toBe('requested');
  });

  it('reports a failed result when configured to fail', () => {
    const store = createHostedJobStore({ now: () => 1_000 });
    store.create(baseJobInput());

    const outcome = runFakeRunner(store, {
      runnerId: 'runner-1',
      capabilities: ['git', 'node'],
      leaseId: 'lease-1',
      ttlMs: 60_000,
      heartbeatIntervalMs: 5_000,
      fail: true,
    });

    expect(outcome.result).toMatchObject({ jobId: 'job-1', outcome: 'failed' });
    expect(store.get('job-1')?.request.status).toBe('failed');
    expect(outcome.trace).toBe('registered -> leased job-1 -> 1 heartbeats -> failed');
  });

  it('emits the configured number of heartbeats before finalizing', () => {
    const store = createHostedJobStore({ now: () => 1_000 });
    store.create(baseJobInput());

    runFakeRunner(store, {
      runnerId: 'runner-1',
      capabilities: ['git', 'node'],
      leaseId: 'lease-1',
      ttlMs: 60_000,
      heartbeatIntervalMs: 5_000,
      heartbeats: 3,
    });

    const job = store.get('job-1');
    expect(job?.events.filter((e) => e.type === 'heartbeat')).toHaveLength(3);
  });
});
