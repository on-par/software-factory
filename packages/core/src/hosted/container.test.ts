import { describe, expect, it } from 'vitest';

import {
  runContainerJob,
  type CloneOutcome,
  type ContainerCleanupProof,
  type ContainerEngine,
  type ContainerRunResult,
} from './container.js';
import {
  prototypeFallbackMint,
  type GitHubAuthorityBrokerOptions,
  type GitHubCredentialBundle,
} from './github-authority.js';
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
  clone?: CloneOutcome;
  artifacts?: ContainerRunResult['artifacts'];
}

interface FakeEngineCalls {
  preparedJobIds: string[];
  removedJobIds: string[];
  repoSlugs: string[];
  credentials: (GitHubCredentialBundle | undefined)[];
}

function createFakeEngine(script: FakeEngineScript, calls: FakeEngineCalls): ContainerEngine {
  return {
    async prepareWorkspace(jobId, _payload, repoSlug, credential) {
      calls.preparedJobIds.push(jobId);
      calls.repoSlugs.push(repoSlug);
      calls.credentials.push(credential);
      return {
        hostPath: `/tmp/${jobId}`,
        containerPayloadPath: '/workspace/payload',
        containerRepoPath: '/workspace/repo',
        clone: script.clone ?? { ok: true, commit: 'deadbeef' },
      };
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
        artifacts: script.artifacts,
      };
    },
    async remove(jobId, _workspaceHostPath): Promise<ContainerCleanupProof> {
      calls.removedJobIds.push(jobId);
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

describe('runContainerJob', () => {
  it('prepares the workspace with the job payload and runs exactly one container (AC#1 + AC#2)', async () => {
    const { store, leaseId } = leasedStore();
    const calls: FakeEngineCalls = { preparedJobIds: [], removedJobIds: [], repoSlugs: [], credentials: [] };
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

  it("clones the job's own repo, never the host checkout (AC#1/#3)", async () => {
    const store = createHostedJobStore({ now: () => 1_000 });
    store.create(baseJobInput({ repoSlug: 'on-par/sound-buddy' }));
    const leaseId = 'lease-1';
    store.acquireLease({ jobId: 'job-1', runnerId: 'r1', leaseId, ttlMs: 60_000, heartbeatIntervalMs: 5_000 });
    const calls: FakeEngineCalls = { preparedJobIds: [], removedJobIds: [], repoSlugs: [], credentials: [] };
    const engine = createFakeEngine({ exitCode: 0 }, calls);

    await runContainerJob(store, engine, {
      jobId: 'job-1',
      leaseId,
      image: 'alpine:3.20',
      command: ['true'],
      timeoutMs: 5_000,
    });

    expect(calls.repoSlugs).toEqual(['on-par/sound-buddy']);
  });

  it('marks the job done and removes the container on exit 0 (AC#3)', async () => {
    const { store, leaseId } = leasedStore();
    const calls: FakeEngineCalls = { preparedJobIds: [], removedJobIds: [], repoSlugs: [], credentials: [] };
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
    expect(outcome.workspaceCommit).toBe('deadbeef');
    expect(calls.removedJobIds).toEqual(['job-1']);
    expect(outcome.cleanup?.removed).toBe(true);
  });

  it('records exitCode, a bounded logsTail, and artifacts on success (#902)', async () => {
    const { store, leaseId } = leasedStore();
    const calls: FakeEngineCalls = { preparedJobIds: [], removedJobIds: [], repoSlugs: [], credentials: [] };
    const artifacts = [{ name: 'build.log', ref: '/artifacts/job-1/build.log', kind: 'log' }];
    const engine = createFakeEngine({ exitCode: 0, logs: 'a'.repeat(2500), artifacts }, calls);

    const outcome = await runContainerJob(store, engine, {
      jobId: 'job-1',
      leaseId,
      image: 'alpine:3.20',
      command: ['true'],
      timeoutMs: 5_000,
    });

    expect(outcome.result?.exitCode).toBe(0);
    expect(outcome.result?.artifacts).toEqual(artifacts);
    expect(outcome.result?.logsTail).toHaveLength(2000);
    expect(outcome.result?.logsTail).toBe('a'.repeat(2000));
  });

  it('marks the job failed with an exit-code reason and still removes the container on non-zero exit (AC#4)', async () => {
    const { store, leaseId } = leasedStore();
    const calls: FakeEngineCalls = { preparedJobIds: [], removedJobIds: [], repoSlugs: [], credentials: [] };
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
    expect(outcome.result?.failurePhase).toBe('run');
    expect(outcome.result?.exitCode).toBe(2);
    expect(outcome.result?.logsTail).toBe('boom');
    expect(calls.removedJobIds).toEqual(['job-1']);
  });

  it('marks the job failed with a timeout reason and still removes the container on timeout (AC#4)', async () => {
    const { store, leaseId } = leasedStore();
    const calls: FakeEngineCalls = { preparedJobIds: [], removedJobIds: [], repoSlugs: [], credentials: [] };
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
    const calls: FakeEngineCalls = { preparedJobIds: [], removedJobIds: [], repoSlugs: [], credentials: [] };
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
    const calls: FakeEngineCalls = { preparedJobIds: [], removedJobIds: [], repoSlugs: [], credentials: [] };
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
    expect(outcome.result?.failurePhase).toBe('run');
    expect(outcome.ranContainer).toBe(false);
    expect(calls.removedJobIds).toEqual(['job-1']);
  });

  it('fails the job cleanly with a clear reason and skips the container run when the clone fails (AC#3)', async () => {
    const { store, leaseId } = leasedStore();
    const calls: FakeEngineCalls = { preparedJobIds: [], removedJobIds: [], repoSlugs: [], credentials: [] };
    const engine = createFakeEngine({ exitCode: 0, clone: { ok: false, error: 'fatal: repository not found' } }, calls);

    const outcome = await runContainerJob(store, engine, {
      jobId: 'job-1',
      leaseId,
      image: 'alpine:3.20',
      command: ['true'],
      timeoutMs: 5_000,
    });

    expect(store.get('job-1')?.request.status).toBe('failed');
    expect(outcome.result?.summary).toContain('repo clone failed:');
    expect(outcome.result?.summary).toContain('fatal: repository not found');
    expect(outcome.result?.failurePhase).toBe('clone');
    expect(outcome.ranContainer).toBe(false);
    expect(outcome.workspaceCommit).toBeUndefined();
    expect(calls.removedJobIds).toEqual(['job-1']);
  });

  it('does not create a container and leaves the job unchanged when the lease does not match', async () => {
    const { store } = leasedStore();
    const calls: FakeEngineCalls = { preparedJobIds: [], removedJobIds: [], repoSlugs: [], credentials: [] };
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

  it('skips engine.run and cleans up when the job is canceled before the run (cooperative cancel, #903)', async () => {
    const { store, leaseId } = leasedStore();
    const calls: FakeEngineCalls = { preparedJobIds: [], removedJobIds: [], repoSlugs: [], credentials: [] };
    const engine = createFakeEngine({ exitCode: 0 }, calls);
    let ranEngineRun = false;
    engine.run = async (spec) => {
      ranEngineRun = true;
      return {
        containerName: `sf-job-${spec.jobId}`,
        exitCode: 0,
        logs: '',
        timedOut: false,
      };
    };
    // Simulate a control-plane cancel arriving during the async workspace-prep
    // gap, before the runner's next cooperative heartbeat checkpoint.
    const originalPrepareWorkspace = engine.prepareWorkspace.bind(engine);
    engine.prepareWorkspace = async (jobId, payload, repoSlug) => {
      const prepared = await originalPrepareWorkspace(jobId, payload, repoSlug);
      store.cancel(jobId, 'operator request');
      return prepared;
    };

    const outcome = await runContainerJob(store, engine, {
      jobId: 'job-1',
      leaseId,
      image: 'alpine:3.20',
      command: ['true'],
      timeoutMs: 5_000,
    });

    expect(ranEngineRun).toBe(false);
    expect(outcome.ranContainer).toBe(false);
    expect(outcome.outcome).toBe('canceled');
    expect(outcome.result?.outcome).toBe('canceled');
    expect(outcome.trace).toBe('leased -> canceled before run -> cleaned');
    expect(calls.removedJobIds).toEqual(['job-1']);
    expect(store.get('job-1')?.events.some((event) => event.type === 'cleaned')).toBe(true);
  });

  it('returns ranContainer: false for an unknown job', async () => {
    const store = createHostedJobStore({ now: () => 1_000 });
    const calls: FakeEngineCalls = { preparedJobIds: [], removedJobIds: [], repoSlugs: [], credentials: [] };
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

  describe('GitHub authority broker (#901)', () => {
    function authorityOptions(): GitHubAuthorityBrokerOptions {
      return { mint: prototypeFallbackMint('super-secret-tok'), now: () => 1_000 };
    }

    it('passes a minted bundle to prepareWorkspace and never leaks the token when hosted exec is on', async () => {
      const { store, leaseId } = leasedStore();
      const calls: FakeEngineCalls = { preparedJobIds: [], removedJobIds: [], repoSlugs: [], credentials: [] };
      const engine = createFakeEngine({ exitCode: 2, logs: 'boom super-secret-tok leaked' }, calls);

      const outcome = await runContainerJob(store, engine, {
        jobId: 'job-1',
        leaseId,
        image: 'alpine:3.20',
        command: ['false'],
        timeoutMs: 5_000,
        authority: authorityOptions(),
        env: { FACTORY_HOSTED_EXEC: '1' },
      });

      expect(calls.credentials[0]?.kind).toBe('prototype-fallback');
      expect(calls.credentials[0]?.token).toBe('super-secret-tok');
      expect(outcome.trace).not.toContain('super-secret-tok');
      expect(outcome.trace).toContain('authority: prototype-fallback');
      expect(outcome.result?.summary ?? '').not.toContain('super-secret-tok');
      const events = store.get('job-1')?.events ?? [];
      for (const event of events) {
        expect(event.message ?? '').not.toContain('super-secret-tok');
      }
    });

    it('passes no credential and behaves exactly like today when the flag is off (AC#5)', async () => {
      const { store, leaseId } = leasedStore();
      const calls: FakeEngineCalls = { preparedJobIds: [], removedJobIds: [], repoSlugs: [], credentials: [] };
      const engine = createFakeEngine({ exitCode: 0 }, calls);

      const outcome = await runContainerJob(store, engine, {
        jobId: 'job-1',
        leaseId,
        image: 'alpine:3.20',
        command: ['true'],
        timeoutMs: 5_000,
        authority: authorityOptions(),
        env: {},
      });

      expect(calls.credentials).toEqual([undefined]);
      expect(outcome.trace).not.toContain('authority:');
      expect(outcome.outcome).toBe('completed');
    });
  });
});
