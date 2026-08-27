import { describe, expect, it } from 'vitest';

import type { CloneOutcome, ContainerCleanupProof, ContainerEngine, ContainerRunResult } from './container.js';
import { runHostedSmoke } from './smoke.js';

const FIXED_NOW = () => Date.parse('2026-01-01T00:00:00.000Z');

interface FakeEngineScript {
  exitCode?: number;
  logs?: string;
  clone?: CloneOutcome;
}

interface FakeEngineCalls {
  prepared: boolean;
  ran: boolean;
  removed: boolean;
}

function createFakeEngine(script: FakeEngineScript, calls: FakeEngineCalls): ContainerEngine {
  return {
    async prepareWorkspace(jobId) {
      calls.prepared = true;
      return {
        hostPath: `/tmp/${jobId}`,
        containerPayloadPath: '/workspace/payload',
        containerRepoPath: '/workspace/repo',
        clone: script.clone ?? { ok: true, commit: 'deadbeef' },
      };
    },
    async run(spec): Promise<ContainerRunResult> {
      calls.ran = true;
      return {
        containerName: `sf-job-${spec.jobId}`,
        exitCode: script.exitCode ?? 0,
        logs: script.logs ?? '',
        timedOut: false,
      };
    },
    async remove(jobId): Promise<ContainerCleanupProof> {
      calls.removed = true;
      return {
        containerName: `sf-job-${jobId}`,
        removed: true,
        workspaceRemoved: true,
        evidence: `removed sf-job-${jobId}; no container matches name`,
      };
    },
  };
}

function baseConfig(overrides: Partial<Parameters<typeof runHostedSmoke>[1]> = {}) {
  return {
    repoSlug: 'on-par/software-factory',
    image: 'node:20-alpine',
    command: ['sh', '-c', 'echo ok'],
    now: FIXED_NOW,
    ...overrides,
  };
}

describe('runHostedSmoke', () => {
  it('refuses to run and touches no engine method when the flag is off', async () => {
    const calls: FakeEngineCalls = { prepared: false, ran: false, removed: false };
    const engine = createFakeEngine({}, calls);

    const outcome = await runHostedSmoke(engine, baseConfig({ env: {} }));

    expect(outcome).toEqual({ enabled: false, trace: 'hosted execution disabled — local factory path unchanged' });
    expect(calls).toEqual({ prepared: false, ran: false, removed: false });
  });

  it('refuses to run when the flag is set to a non-"1" value', async () => {
    const calls: FakeEngineCalls = { prepared: false, ran: false, removed: false };
    const engine = createFakeEngine({}, calls);

    const outcome = await runHostedSmoke(engine, baseConfig({ env: { FACTORY_HOSTED_EXEC: '0' } }));

    expect(outcome.enabled).toBe(false);
    expect(calls.prepared).toBe(false);
  });

  it('drives the job to completed with cleanup proof when the container exits 0', async () => {
    const calls: FakeEngineCalls = { prepared: false, ran: false, removed: false };
    const engine = createFakeEngine({ exitCode: 0, logs: 'hosted-exec-smoke-ok' }, calls);

    const outcome = await runHostedSmoke(engine, baseConfig({ env: { FACTORY_HOSTED_EXEC: '1' } }));

    expect(outcome.enabled).toBe(true);
    expect(outcome.jobId).toBe('smoke-job-1');
    expect(outcome.leaseId).toBe('smoke-lease-1');
    expect(outcome.summary?.outcome).toBe('completed');
    expect(outcome.summary?.exitCode).toBe(0);
    expect(outcome.summary?.repoSlug).toBe('on-par/software-factory');
    expect(outcome.summary?.cleanupProof).toBeTruthy();
    expect(calls).toEqual({ prepared: true, ran: true, removed: true });
  });

  it('marks the job failed with failurePhase "run" when the container exits non-zero, cleanup still recorded', async () => {
    const calls: FakeEngineCalls = { prepared: false, ran: false, removed: false };
    const engine = createFakeEngine({ exitCode: 1, logs: 'boom' }, calls);

    const outcome = await runHostedSmoke(engine, baseConfig({ env: { FACTORY_HOSTED_EXEC: '1' } }));

    expect(outcome.summary?.outcome).toBe('failed');
    expect(outcome.summary?.failurePhase).toBe('run');
    expect(calls.removed).toBe(true);
  });

  it('marks the job failed with failurePhase "clone" when the fresh clone fails, cleanup still recorded', async () => {
    const calls: FakeEngineCalls = { prepared: false, ran: false, removed: false };
    const engine = createFakeEngine({ clone: { ok: false, error: 'not found' } }, calls);

    const outcome = await runHostedSmoke(engine, baseConfig({ env: { FACTORY_HOSTED_EXEC: '1' } }));

    expect(outcome.summary?.outcome).toBe('failed');
    expect(outcome.summary?.failurePhase).toBe('clone');
    expect(calls.ran).toBe(false);
    expect(calls.removed).toBe(true);
  });
});
