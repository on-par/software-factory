import { describe, expect, it } from 'vitest';

import { createHostedJobStore, type CreateHostedJobInput } from './store.js';
import { summarizeHostedJob, summarizeHostedJobs } from './summary.js';

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

describe('summarizeHostedJob', () => {
  it('summarizes a completed job with outcome, exitCode, artifacts, and cleanup proof', () => {
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
    store.complete('job-1', 'lease-1', 'all green', { exitCode: 0, logsTail: 'tail', artifacts });
    store.recordCleanup('job-1', 'removed sf-job-job-1; no container matches name');

    const job = store.get('job-1');
    if (!job) {
      throw new Error('expected job-1 to exist');
    }
    const summary = summarizeHostedJob(job);

    expect(summary).toMatchObject({
      jobId: 'job-1',
      repoSlug: 'on-par/software-factory',
      status: 'done',
      outcome: 'completed',
      summary: 'all green',
      exitCode: 0,
      failurePhase: null,
      artifacts,
      artifactCount: 1,
      logsTail: 'tail',
      cleanupProof: 'cleanup proof: removed sf-job-job-1; no container matches name',
    });
    expect(summary.eventCount).toBe(job.events.length);
    expect(summary.lastEvent).toEqual(job.events.at(-1));
    expect(summary.updatedAt).toBe(job.updatedAt);
  });

  it('summarizes a failed job with failurePhase and logsTail', () => {
    const store = createHostedJobStore({ now: () => 1_000 });
    store.create(baseJobInput({ jobId: 'job-2' }));
    store.acquireLease({
      jobId: 'job-2',
      runnerId: 'runner-1',
      leaseId: 'lease-1',
      ttlMs: 60_000,
      heartbeatIntervalMs: 5_000,
    });
    store.fail('job-2', 'lease-1', 'container exit 1', { failurePhase: 'run', exitCode: 1, logsTail: 'boom' });

    const job = store.get('job-2');
    if (!job) {
      throw new Error('expected job-2 to exist');
    }
    const summary = summarizeHostedJob(job);

    expect(summary).toMatchObject({
      status: 'failed',
      outcome: 'failed',
      failurePhase: 'run',
      exitCode: 1,
      logsTail: 'boom',
      artifacts: [],
      artifactCount: 0,
      cleanupProof: null,
    });
  });

  it('summarizes an active (leased/running) job with null outcome/result fields', () => {
    const store = createHostedJobStore({ now: () => 1_000 });
    store.create(baseJobInput({ jobId: 'job-3' }));
    store.acquireLease({
      jobId: 'job-3',
      runnerId: 'runner-1',
      leaseId: 'lease-1',
      ttlMs: 60_000,
      heartbeatIntervalMs: 5_000,
    });

    const job = store.get('job-3');
    if (!job) {
      throw new Error('expected job-3 to exist');
    }
    const summary = summarizeHostedJob(job);

    expect(summary).toMatchObject({
      status: 'leased',
      outcome: null,
      summary: null,
      exitCode: null,
      failurePhase: null,
      artifacts: [],
      artifactCount: 0,
      logsTail: null,
      cleanupProof: null,
    });
  });

  it('exposes no secret material — artifacts are metadata-only by shape', () => {
    const store = createHostedJobStore({ now: () => 1_000 });
    store.create(baseJobInput({ jobId: 'job-4' }));
    store.acquireLease({
      jobId: 'job-4',
      runnerId: 'runner-1',
      leaseId: 'lease-1',
      ttlMs: 60_000,
      heartbeatIntervalMs: 5_000,
    });
    const artifacts = [{ name: 'coverage', ref: '/artifacts/job-4/coverage.json', kind: 'report', sizeBytes: 10 }];
    store.complete('job-4', 'lease-1', 'done', { artifacts });

    const job = store.get('job-4');
    if (!job) {
      throw new Error('expected job-4 to exist');
    }
    const summary = summarizeHostedJob(job);

    for (const artifact of summary.artifacts) {
      expect(Object.keys(artifact).sort()).toEqual(['kind', 'name', 'ref', 'sizeBytes'].sort());
    }
  });
});

describe('summarizeHostedJobs', () => {
  it('maps a list of stored jobs to summaries in order', () => {
    const store = createHostedJobStore({ now: () => 1_000 });
    store.create(baseJobInput({ jobId: 'job-a' }));
    store.create(baseJobInput({ jobId: 'job-b' }));

    const summaries = summarizeHostedJobs(store.list());

    expect(summaries.map((s) => s.jobId)).toEqual(['job-a', 'job-b']);
    expect(summaries.every((s) => s.status === 'requested')).toBe(true);
  });

  it('returns an empty array for an empty job list', () => {
    expect(summarizeHostedJobs([])).toEqual([]);
  });
});
