import { describe, expect, it } from 'vitest';

import {
  runContainerJob,
  type ContainerCleanupProof,
  type ContainerEngine,
  type ContainerRunResult,
} from './container.js';
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

function leasedStore(now: () => number = () => 1_000): { store: HostedJobStore; leaseId: string } {
  const store = createHostedJobStore({ now });
  store.create(baseJobInput());
  const leaseId = 'lease-1';
  store.acquireLease({ jobId: 'job-1', runnerId: 'r1', leaseId, ttlMs: 60_000, heartbeatIntervalMs: 5_000 });
  return { store, leaseId };
}

interface FakeEngineScript {
  exitCode?: number;
  timedOut?: boolean;
  logs?: string;
  runError?: Error;
}

interface FakeEngineCalls {
  preparedJobIds: string[];
  removedJobIds: string[];
}

function createFakeEngine(script: FakeEngineScript, calls: FakeEngineCalls): ContainerEngine {
  return {
    async prepareWorkspace(jobId, _payload) {
      calls.preparedJobIds.push(jobId);
      return { hostPath: `/tmp/${jobId}`, containerPayloadPath: '/workspace/payload' };
    },
    async run(spec): Promise<ContainerRunResult> {
      if (script.runError) {
        throw script.runError;
      }
      return {
        containerName: `sf-job-${spec.jobId}`,
        exitCode: script.exitCode ?? 0,
        logs: script.logs ?? '',
        timedOut: script.timedOut ?? false,
      };
    },
    async remove(jobId, _workspaceHostPath): Promise<ContainerCleanupProof> {
      calls.removedJobIds.push(jobId);
      return {
        containerName: `sf-job-${jobId}`,
        removed: true,
        workspaceRemoved: true,
        evidence: `removed sf-job-${jobId}; no container matches name`,
      };
    },
  };
}

describe('runContainerJob', () => {
  it('prepares the workspace with the job payload and runs exactly one container (AC#1 + AC#2)', async () => {
    const { store, leaseId } = leasedStore();
    const calls: FakeEngineCalls = { preparedJobIds: [], removedJobIds: [] };
    const engine = createFakeEngine({ exitCode: 0 }, calls);

    const outcome = await runContainerJob(store, engine, {
      jobId: 'job-1',
      leaseId,
      image: 'alpine:3.20',
      command: ['true'],
      timeoutMs: 5_000,
    });

    expect(calls.preparedJobIds).toEqual(['job-1']);
    expect(outcome.ranContainer).toBe(true);
    expect(outcome.containerName).toBe('sf-job-job-1');
  });

  it('marks the job done and removes the container on exit 0 (AC#3)', async () => {
    const { store, leaseId } = leasedStore();
    const calls: FakeEngineCalls = { preparedJobIds: [], removedJobIds: [] };
    const engine = createFakeEngine({ exitCode: 0 }, calls);

    const outcome = await runContainerJob(store, engine, {
      jobId: 'job-1',
      leaseId,
      image: 'alpine:3.20',
      command: ['true'],
      timeoutMs: 5_000,
    });

    expect(store.get('job-1')?.request.status).toBe('done');
    expect(outcome.outcome).toBe('completed');
    expect(outcome.result?.outcome).toBe('completed');
    expect(calls.removedJobIds).toEqual(['job-1']);
    expect(outcome.cleanup?.removed).toBe(true);
  });

  it('marks the job failed with an exit-code reason and still removes the container on non-zero exit (AC#4)', async () => {
    const { store, leaseId } = leasedStore();
    const calls: FakeEngineCalls = { preparedJobIds: [], removedJobIds: [] };
    const engine = createFakeEngine({ exitCode: 2, logs: 'boom' }, calls);

    const outcome = await runContainerJob(store, engine, {
      jobId: 'job-1',
      leaseId,
      image: 'alpine:3.20',
      command: ['false'],
      timeoutMs: 5_000,
    });

    expect(store.get('job-1')?.request.status).toBe('failed');
    expect(outcome.outcome).toBe('failed');
    expect(outcome.result?.summary).toContain('exit 2');
    expect(outcome.result?.summary).toContain('boom');
    expect(calls.removedJobIds).toEqual(['job-1']);
  });

  it('marks the job failed with a timeout reason and still removes the container on timeout (AC#4)', async () => {
    const { store, leaseId } = leasedStore();
    const calls: FakeEngineCalls = { preparedJobIds: [], removedJobIds: [] };
    const engine = createFakeEngine({ exitCode: 0, timedOut: true }, calls);

    const outcome = await runContainerJob(store, engine, {
      jobId: 'job-1',
      leaseId,
      image: 'alpine:3.20',
      command: ['sleep', '9999'],
      timeoutMs: 5_000,
    });

    expect(store.get('job-1')?.request.status).toBe('failed');
    expect(outcome.result?.summary).toContain('timed out after 5000ms');
    expect(calls.removedJobIds).toEqual(['job-1']);
  });

  it('records a cleaned event with cleanup evidence after a terminal outcome (AC#5)', async () => {
    const { store, leaseId } = leasedStore();
    const calls: FakeEngineCalls = { preparedJobIds: [], removedJobIds: [] };
    const engine = createFakeEngine({ exitCode: 0 }, calls);

    await runContainerJob(store, engine, {
      jobId: 'job-1',
      leaseId,
      image: 'alpine:3.20',
      command: ['true'],
      timeoutMs: 5_000,
    });

    const events = store.get('job-1')?.events ?? [];
    const cleaned = events.find((event) => event.type === 'cleaned');
    expect(cleaned?.message).toContain('removed sf-job-job-1; no container matches name');
  });

  it('marks the job failed and still removes the container when engine.run throws', async () => {
    const { store, leaseId } = leasedStore();
    const calls: FakeEngineCalls = { preparedJobIds: [], removedJobIds: [] };
    const engine = createFakeEngine({ runError: new Error('docker daemon unreachable') }, calls);

    const outcome = await runContainerJob(store, engine, {
      jobId: 'job-1',
      leaseId,
      image: 'alpine:3.20',
      command: ['true'],
      timeoutMs: 5_000,
    });

    expect(store.get('job-1')?.request.status).toBe('failed');
    expect(outcome.result?.summary).toContain('docker daemon unreachable');
    expect(outcome.ranContainer).toBe(false);
    expect(calls.removedJobIds).toEqual(['job-1']);
  });

  it('does not create a container and leaves the job unchanged when the lease does not match', async () => {
    const { store } = leasedStore();
    const calls: FakeEngineCalls = { preparedJobIds: [], removedJobIds: [] };
    const engine = createFakeEngine({ exitCode: 0 }, calls);
    const before = store.get('job-1');

    const outcome = await runContainerJob(store, engine, {
      jobId: 'job-1',
      leaseId: 'wrong-lease',
      image: 'alpine:3.20',
      command: ['true'],
      timeoutMs: 5_000,
    });

    expect(outcome).toEqual({ jobId: 'job-1', ranContainer: false, trace: 'job not leased by this runner' });
    expect(calls.preparedJobIds).toEqual([]);
    expect(calls.removedJobIds).toEqual([]);
    expect(store.get('job-1')).toEqual(before);
  });

  it('returns ranContainer: false for an unknown job', async () => {
    const store = createHostedJobStore({ now: () => 1_000 });
    const calls: FakeEngineCalls = { preparedJobIds: [], removedJobIds: [] };
    const engine = createFakeEngine({ exitCode: 0 }, calls);

    const outcome = await runContainerJob(store, engine, {
      jobId: 'missing',
      leaseId: 'lease-1',
      image: 'alpine:3.20',
      command: ['true'],
      timeoutMs: 5_000,
    });

    expect(outcome.ranContainer).toBe(false);
    expect(calls.preparedJobIds).toEqual([]);
  });
});
