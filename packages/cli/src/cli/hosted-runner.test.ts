// packages/cli/src/cli/hosted-runner.test.ts

import type { HostedControlPlaneClient, OneJobRunnerOutcome } from '@on-par/factory-core';
import { describe, expect, it, vi } from 'vitest';

import { formatHostedRunnerOutcome, runHostedRunnerCli } from './hosted-runner.js';

function outStub() {
  const written: string[] = [];
  return { written, out: { write: (s: string) => written.push(s) } };
}

function fakeClient(overrides: Partial<HostedControlPlaneClient> = {}): HostedControlPlaneClient {
  return {
    registerRunner: vi.fn().mockResolvedValue({
      runnerId: 'runner-1',
      capabilities: ['git', 'node'],
      available: true,
      lastHeartbeatAt: 'now',
    }),
    pollForLease: vi.fn().mockResolvedValue({ ok: false, reason: 'no-match' }),
    ...overrides,
  };
}

describe('runHostedRunnerCli', () => {
  it('refuses to run and exits 0 when the hosted-exec flag is off', async () => {
    const { written, out } = outStub();
    const client = fakeClient();
    const { exitCode } = await runHostedRunnerCli({}, { env: {}, out, client });

    expect(exitCode).toBe(0);
    expect(written.join('')).toMatch(/FACTORY_HOSTED_EXEC/);
    expect(client.registerRunner).not.toHaveBeenCalled();
  });

  it('registers with the requested capabilities, leases the first compatible job, and exits 0', async () => {
    const { out } = outStub();
    const job = {
      jobId: 'job-1',
      repoSlug: 'on-par/software-factory',
      status: 'leased' as const,
      leasedBy: 'runner-1',
      outcome: null,
      summary: null,
      exitCode: null,
      failurePhase: null,
      eventCount: 2,
      lastEvent: null,
      artifacts: [],
      artifactCount: 0,
      logsTail: null,
      cleanupProof: null,
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const lease = {
      runnerId: 'runner-1',
      leaseId: 'fixed-lease',
      jobId: 'job-1',
      expiresAt: '2026-01-01T00:05:00.000Z',
      heartbeatIntervalMs: 30_000,
    };
    const client = fakeClient({ pollForLease: vi.fn().mockResolvedValue({ ok: true, lease, job }) });

    const { exitCode } = await runHostedRunnerCli(
      { runnerId: 'runner-1', capabilities: 'git,node' },
      { env: { FACTORY_HOSTED_EXEC: '1' }, out, client, generateLeaseId: () => 'fixed-lease' },
    );

    expect(exitCode).toBe(0);
    expect(client.registerRunner).toHaveBeenCalledWith({ runnerId: 'runner-1', capabilities: ['git', 'node'] });
    expect(client.pollForLease).toHaveBeenCalledWith(
      expect.objectContaining({ runnerId: 'runner-1', leaseId: 'fixed-lease', capabilities: ['git', 'node'] }),
    );
  });

  it('exits 0 cleanly when no compatible job appears within the bounded wait window', async () => {
    const { written, out } = outStub();
    const client = fakeClient();

    let now = 0;
    const { exitCode } = await runHostedRunnerCli(
      { timeout: '10', pollInterval: '5' },
      {
        env: { FACTORY_HOSTED_EXEC: '1' },
        out,
        client,
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(written.join('')).toMatch(/no compatible job/);
  });
});

describe('formatHostedRunnerOutcome', () => {
  it('renders the trace only when no job was leased', () => {
    const outcome: OneJobRunnerOutcome = {
      leased: false,
      runner: { runnerId: 'runner-1', capabilities: [], available: true, lastHeartbeatAt: 'now' },
      attempts: 3,
      trace: 'registered runner-1 -> no compatible job within 30000ms (3 poll(s))',
    };
    expect(formatHostedRunnerOutcome(outcome)).toBe(
      'registered runner-1 -> no compatible job within 30000ms (3 poll(s))\n',
    );
  });

  it('renders job/runner/lease/status when a job was leased', () => {
    const outcome: OneJobRunnerOutcome = {
      leased: true,
      runner: { runnerId: 'runner-1', capabilities: ['git'], available: false, lastHeartbeatAt: 'now' },
      attempts: 1,
      jobId: 'job-1',
      lease: {
        runnerId: 'runner-1',
        leaseId: 'lease-1',
        jobId: 'job-1',
        expiresAt: '2026-01-01T00:05:00.000Z',
        heartbeatIntervalMs: 30_000,
      },
      job: {
        jobId: 'job-1',
        repoSlug: 'on-par/software-factory',
        status: 'leased',
        leasedBy: 'runner-1',
        outcome: null,
        summary: null,
        exitCode: null,
        failurePhase: null,
        eventCount: 1,
        lastEvent: null,
        artifacts: [],
        artifactCount: 0,
        logsTail: null,
        cleanupProof: null,
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      trace: 'registered runner-1 -> leased job-1 after 1 poll(s)',
    };
    const text = formatHostedRunnerOutcome(outcome);
    expect(text).toContain('job:      job-1');
    expect(text).toContain('runner:   runner-1');
    expect(text).toContain('lease:    lease-1');
    expect(text).toContain('status:   leased');
  });
});
