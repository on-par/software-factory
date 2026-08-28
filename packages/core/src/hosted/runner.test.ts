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
  cleanupError?: Error;
}

interface FakeEngineCalls {
  preparedJobIds: string[];
  credentials: (GitHubCredentialBundle | undefined)[];
  removed: { jobId: string; workspaceHostPath: string }[];
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
    async remove(jobId, workspaceHostPath): Promise<ContainerCleanupProof> {
      calls.removed.push({ jobId, workspaceHostPath });
      if (script.cleanupError) {
        throw script.cleanupError;
      }
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

  it('posts periodic running-state heartbeats while the container is active, finalizes, then stops', async () => {
    vi.useFakeTimers();
    const store = createHostedJobStore({ now: () => 1_000 });
    store.create(baseJobInput());

    const deferred = createDeferred<ContainerRunResult>();
    const calls: FakeEngineCalls = { preparedJobIds: [], credentials: [], removed: [] };
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
    expect(outcome.terminalReported).toBe(true);
    expect(outcome.outcome).toBe('completed');
    expect(outcome.result).toMatchObject({ jobId: 'job-1', outcome: 'completed', exitCode: 0, logsTail: 'ok' });
    expect(outcome.cleanup).toMatchObject({ removed: true, workspaceRemoved: true });
    expect(outcome.trace).toContain('completed -> cleaned');

    // No further heartbeats after the run resolves and the interval is cleared.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(store.get('job-1')?.events.filter((e) => e.type === 'heartbeat')).toHaveLength(3);

    const job = store.get('job-1');
    expect(job?.request.status).toBe('done');
    expect(job?.lease).toBeNull();
    expect(job?.result).toMatchObject({ jobId: 'job-1', outcome: 'completed', exitCode: 0, logsTail: 'ok' });
    expect(job?.events.at(-1)).toMatchObject({
      type: 'cleaned',
      message: 'cleanup proof: removed sf-job-job-1; no container matches name',
    });
    expect(calls.removed).toEqual([{ jobId: 'job-1', workspaceHostPath: '/tmp/job-1' }]);
  });

  it('reports a non-zero exit code and timeout flag as terminal failure', async () => {
    const store = createHostedJobStore({ now: () => 1_000 });
    store.create(baseJobInput());
    const calls: FakeEngineCalls = { preparedJobIds: [], credentials: [], removed: [] };
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
    expect(outcome.terminalReported).toBe(true);
    expect(outcome.outcome).toBe('failed');
    expect(store.get('job-1')?.request.status).toBe('failed');
    expect(store.get('job-1')?.lease).toBeNull();
    expect(store.get('job-1')?.result).toMatchObject({
      outcome: 'failed',
      failurePhase: 'run',
      exitCode: 137,
      logsTail: 'boom',
    });
    expect(store.get('job-1')?.events.some((e) => e.type === 'cleaned')).toBe(true);
  });

  it('returns leased:false and never touches the container engine when no compatible job exists', async () => {
    const store = createHostedJobStore({ now: () => 1_000 });
    store.create(baseJobInput({ requiredCapabilities: ['docker'] }));
    const calls: FakeEngineCalls = { preparedJobIds: [], credentials: [], removed: [] };
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
    expect(outcome.terminalReported).toBe(false);
    expect(calls.preparedJobIds).toEqual([]);
    expect(calls.removed).toEqual([]);
  });

  it('reports a redacted clone error as terminal failure and skips running the container', async () => {
    const store = createHostedJobStore({ now: () => 1_000 });
    store.create(baseJobInput());
    const calls: FakeEngineCalls = { preparedJobIds: [], credentials: [], removed: [] };
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
    expect(outcome.terminalReported).toBe(true);
    expect(outcome.outcome).toBe('failed');
    expect(outcome.trace).toContain('clone failed');
    expect(store.get('job-1')?.request.status).toBe('failed');
    expect(store.get('job-1')?.lease).toBeNull();
    expect(store.get('job-1')?.result).toMatchObject({ outcome: 'failed', failurePhase: 'clone' });
    expect(store.get('job-1')?.events.some((e) => e.type === 'cleaned')).toBe(true);
    expect(calls.removed).toEqual([{ jobId: 'job-1', workspaceHostPath: '/tmp/job-1' }]);
  });

  it('reports artifact references on a successful container run', async () => {
    const store = createHostedJobStore({ now: () => 1_000 });
    store.create(baseJobInput());
    const calls: FakeEngineCalls = { preparedJobIds: [], credentials: [], removed: [] };
    const artifact = { name: 'build.log', ref: '/workspace/build.log', kind: 'log' };
    const engine = createFakeEngine(
      {
        run: Promise.resolve({
          containerName: 'sf-job-job-1',
          exitCode: 0,
          logs: 'ok',
          timedOut: false,
          artifacts: [artifact],
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
    });

    expect(outcome.result?.artifacts).toEqual([artifact]);
    expect(store.get('job-1')?.result?.artifacts).toEqual([artifact]);
  });

  it('records cleanup proof in the outcome and job events', async () => {
    const store = createHostedJobStore({ now: () => 1_000 });
    store.create(baseJobInput());
    const calls: FakeEngineCalls = { preparedJobIds: [], credentials: [], removed: [] };
    const engine = createFakeEngine(
      { run: Promise.resolve({ containerName: 'sf-job-job-1', exitCode: 0, logs: 'ok', timedOut: false }) },
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

    expect(outcome.cleanup).toMatchObject({
      containerName: 'sf-job-job-1',
      removed: true,
      workspaceRemoved: true,
      credentialRemoved: true,
    });
    expect(store.get('job-1')?.events.at(-1)?.message).toContain('removed sf-job-job-1; no container matches name');
  });

  it('returns a clean terminal outcome and releases the lease after one successful job', async () => {
    const store = createHostedJobStore({ now: () => 1_000 });
    store.create(baseJobInput());
    const calls: FakeEngineCalls = { preparedJobIds: [], credentials: [], removed: [] };
    const engine = createFakeEngine(
      { run: Promise.resolve({ containerName: 'sf-job-job-1', exitCode: 0, logs: 'ok', timedOut: false }) },
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

    expect(outcome.terminalReported).toBe(true);
    expect(outcome.outcome).toBe('completed');
    expect(store.get('job-1')?.lease).toBeNull();
    expect(outcome.runner.available).toBe(true);
  });

  it('fails and records cleanup when the container run rejects', async () => {
    const store = createHostedJobStore({ now: () => 1_000 });
    store.create(baseJobInput());
    const calls: FakeEngineCalls = { preparedJobIds: [], credentials: [], removed: [] };
    const engine = createFakeEngine({ run: Promise.reject(new Error('docker daemon unavailable')) }, calls);

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
    expect(outcome.terminalReported).toBe(true);
    expect(outcome.outcome).toBe('failed');
    expect(store.get('job-1')?.request.status).toBe('failed');
    expect(store.get('job-1')?.result).toMatchObject({ outcome: 'failed', failurePhase: 'run' });
    expect(store.get('job-1')?.events.at(-1)?.type).toBe('cleaned');
  });

  it('exits cleanly after terminal reporting when cleanup throws', async () => {
    const store = createHostedJobStore({ now: () => 1_000 });
    store.create(baseJobInput());
    const calls: FakeEngineCalls = { preparedJobIds: [], credentials: [], removed: [] };
    const engine = createFakeEngine(
      {
        run: Promise.resolve({ containerName: 'sf-job-job-1', exitCode: 0, logs: 'ok', timedOut: false }),
        cleanupError: new Error('docker remove failed'),
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

    expect(outcome.terminalReported).toBe(true);
    expect(outcome.outcome).toBe('completed');
    expect(outcome.cleanup).toBeUndefined();
    expect(outcome.cleanupError).toBe('docker remove failed');
    expect(outcome.trace).toContain('completed -> cleanup failed: docker remove failed');
    expect(store.get('job-1')?.request.status).toBe('done');
    expect(store.get('job-1')?.events.some((e) => e.type === 'cleaned')).toBe(false);
  });

  it('brokers and redacts a GitHub credential when authority is configured', async () => {
    const store = createHostedJobStore({ now: () => 1_000 });
    store.create(baseJobInput());
    const calls: FakeEngineCalls = { preparedJobIds: [], credentials: [], removed: [] };
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
    expect(store.get('job-1')?.result?.logsTail).not.toContain('super-secret-token');
    expect(store.get('job-1')?.events.at(-1)?.message).not.toContain('super-secret-token');
  });
});
