import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CloneOutcome, ContainerCleanupProof, ContainerEngine, ContainerRunResult } from './container.js';
import { prototypeFallbackMint, type GitHubCredentialBundle } from './github-authority.js';
import { createHostedJobStore, type CreateHostedJobInput } from './store.js';
import { runDockerRunner, runFakeRunner } from './runner.js';

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

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

interface FakeEngineScript {
  clone?: CloneOutcome;
  run: Promise<ContainerRunResult>;
}

interface FakeEngineCalls {
  preparedJobIds: string[];
  credentials: (GitHubCredentialBundle | undefined)[];
}

function createFakeEngine(script: FakeEngineScript, calls: FakeEngineCalls): ContainerEngine {
  return {
    async prepareWorkspace(jobId, _payload, _repoSlug, credential) {
      calls.preparedJobIds.push(jobId);
      calls.credentials.push(credential);
      return {
        hostPath: `/tmp/${jobId}`,
        containerPayloadPath: '/workspace/payload',
        containerRepoPath: '/workspace/repo',
        clone: script.clone ?? { ok: true, commit: 'deadbeef' },
      };
    },
    run: () => script.run,
    async remove(jobId, _workspaceHostPath): Promise<ContainerCleanupProof> {
      return {
        containerName: `sf-job-${jobId}`,
        removed: true,
        workspaceRemoved: true,
        credentialRemoved: true,
        evidence: `removed sf-job-${jobId}; no container matches name`,
      };
    },
  };
}

describe('runDockerRunner', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('posts periodic running-state heartbeats while the container is active, then stops without finalizing', async () => {
    vi.useFakeTimers();
    const store = createHostedJobStore({ now: () => 1_000 });
    store.create(baseJobInput());

    const deferred = createDeferred<ContainerRunResult>();
    const calls: FakeEngineCalls = { preparedJobIds: [], credentials: [] };
    const engine = createFakeEngine({ run: deferred.promise }, calls);

    const outcomePromise = runDockerRunner(store, engine, {
      runnerId: 'runner-1',
      capabilities: ['git', 'node'],
      leaseId: 'lease-1',
      ttlMs: 60_000,
      heartbeatIntervalMs: 5_000,
      image: 'alpine:3.20',
      command: ['true'],
      timeoutMs: 30_000,
    });

    // Let the initial (pre-run) heartbeat and workspace prep microtasks flush.
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.preparedJobIds).toEqual(['job-1']);
    expect(store.get('job-1')?.request.status).toBe('running');

    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(store.get('job-1')?.events.filter((e) => e.type === 'heartbeat')).toHaveLength(3);

    deferred.resolve({ containerName: 'sf-job-job-1', exitCode: 0, logs: 'ok', timedOut: false });
    const outcome = await outcomePromise;

    expect(outcome.leased).toBe(true);
    expect(outcome.ranContainer).toBe(true);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.logsTail).toBe('ok');
    expect(outcome.heartbeats).toBe(3);
    expect(outcome.trace).toContain('awaiting terminal report');

    // No further heartbeats after the run resolves and the interval is cleared.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(store.get('job-1')?.events.filter((e) => e.type === 'heartbeat')).toHaveLength(3);

    // The runner never finalizes the job.
    const job = store.get('job-1');
    expect(job?.request.status).toBe('running');
    expect(job?.result).toBeNull();
  });

  it('captures a non-zero exit code and timeout flag without finalizing', async () => {
    const store = createHostedJobStore({ now: () => 1_000 });
    store.create(baseJobInput());
    const calls: FakeEngineCalls = { preparedJobIds: [], credentials: [] };
    const engine = createFakeEngine(
      { run: Promise.resolve({ containerName: 'sf-job-job-1', exitCode: 137, logs: 'boom', timedOut: true }) },
      calls,
    );

    const outcome = await runDockerRunner(store, engine, {
      runnerId: 'runner-1',
      capabilities: ['git', 'node'],
      leaseId: 'lease-1',
      ttlMs: 60_000,
      heartbeatIntervalMs: 5_000,
      image: 'alpine:3.20',
      command: ['false'],
      timeoutMs: 30_000,
    });

    expect(outcome.exitCode).toBe(137);
    expect(outcome.timedOut).toBe(true);
    expect(outcome.logsTail).toBe('boom');
    expect(store.get('job-1')?.request.status).toBe('running');
    expect(store.get('job-1')?.result).toBeNull();
  });

  it('returns leased:false and never touches the container engine when no compatible job exists', async () => {
    const store = createHostedJobStore({ now: () => 1_000 });
    store.create(baseJobInput({ requiredCapabilities: ['docker'] }));
    const calls: FakeEngineCalls = { preparedJobIds: [], credentials: [] };
    const engine = createFakeEngine(
      { run: Promise.resolve({ containerName: 'x', exitCode: 0, logs: '', timedOut: false }) },
      calls,
    );

    const outcome = await runDockerRunner(store, engine, {
      runnerId: 'runner-1',
      capabilities: ['git', 'node'],
      leaseId: 'lease-1',
      ttlMs: 60_000,
      heartbeatIntervalMs: 5_000,
      image: 'alpine:3.20',
      command: ['true'],
      timeoutMs: 30_000,
    });

    expect(outcome.leased).toBe(false);
    expect(outcome.ranContainer).toBe(false);
    expect(outcome.heartbeats).toBe(0);
    expect(calls.preparedJobIds).toEqual([]);
  });

  it('reports a redacted clone error and skips running the container when the workspace clone fails', async () => {
    const store = createHostedJobStore({ now: () => 1_000 });
    store.create(baseJobInput());
    const calls: FakeEngineCalls = { preparedJobIds: [], credentials: [] };
    const engine = createFakeEngine(
      {
        clone: { ok: false, error: 'fatal: could not read from remote repository' },
        run: Promise.resolve({ containerName: 'x', exitCode: 0, logs: '', timedOut: false }),
      },
      calls,
    );

    const outcome = await runDockerRunner(store, engine, {
      runnerId: 'runner-1',
      capabilities: ['git', 'node'],
      leaseId: 'lease-1',
      ttlMs: 60_000,
      heartbeatIntervalMs: 5_000,
      image: 'alpine:3.20',
      command: ['true'],
      timeoutMs: 30_000,
    });

    expect(outcome.ranContainer).toBe(false);
    expect(outcome.cloneError).toBe('fatal: could not read from remote repository');
    expect(outcome.heartbeats).toBe(1);
    expect(outcome.trace).toContain('clone failed');
    expect(store.get('job-1')?.request.status).toBe('running');
    expect(store.get('job-1')?.result).toBeNull();
  });

  it('brokers and redacts a GitHub credential when authority is configured', async () => {
    const store = createHostedJobStore({ now: () => 1_000 });
    store.create(baseJobInput());
    const calls: FakeEngineCalls = { preparedJobIds: [], credentials: [] };
    const engine = createFakeEngine(
      {
        run: Promise.resolve({
          containerName: 'sf-job-job-1',
          exitCode: 0,
          logs: 'token=super-secret-token ok',
          timedOut: false,
        }),
      },
      calls,
    );

    const outcome = await runDockerRunner(store, engine, {
      runnerId: 'runner-1',
      capabilities: ['git', 'node'],
      leaseId: 'lease-1',
      ttlMs: 60_000,
      heartbeatIntervalMs: 5_000,
      image: 'alpine:3.20',
      command: ['true'],
      timeoutMs: 30_000,
      env: { FACTORY_HOSTED_EXEC: '1' },
      authority: { mint: prototypeFallbackMint('super-secret-token'), now: () => 1_000 },
    });

    expect(calls.credentials[0]?.token).toBe('super-secret-token');
    expect(outcome.logsTail).not.toContain('super-secret-token');
    expect(outcome.logsTail).toContain('[redacted]');
  });
});
