import { describe, expect, it, vi } from 'vitest';

import type { RunnerLease } from '@on-par/contracts';

import type { HostedJobSummary } from './summary.js';
import {
  createHttpHostedControlPlaneClient,
  runOneJobRunner,
  type HostedControlPlaneClient,
  type HostedControlPlaneFetchFn,
  type PollForLeaseResult,
  type RegisteredRunner,
} from './runner-client.js';

function fakeRunner(overrides: Partial<RegisteredRunner> = {}): RegisteredRunner {
  return { runnerId: 'runner-1', capabilities: ['git', 'node'], available: true, lastHeartbeatAt: 'now', ...overrides };
}

function fakeLease(overrides: Partial<RunnerLease> = {}): RunnerLease {
  return {
    runnerId: 'runner-1',
    leaseId: 'lease-1',
    jobId: 'job-1',
    expiresAt: '2026-01-01T00:05:00.000Z',
    heartbeatIntervalMs: 5_000,
    ...overrides,
  };
}

function fakeSummary(overrides: Partial<HostedJobSummary> = {}): HostedJobSummary {
  return {
    jobId: 'job-1',
    repoSlug: 'on-par/software-factory',
    status: 'leased',
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
    ...overrides,
  };
}

const BASE_CONFIG = {
  runnerId: 'runner-1',
  capabilities: ['git', 'node'],
  leaseId: 'lease-1',
  ttlMs: 300_000,
  heartbeatIntervalMs: 30_000,
};

describe('runOneJobRunner', () => {
  it('registers then leases the first compatible job on the first poll', async () => {
    const job = fakeSummary();
    const lease = fakeLease();
    const registerRunner = vi.fn().mockResolvedValue(fakeRunner());
    const pollForLease = vi.fn().mockResolvedValue({ ok: true, lease, job } satisfies PollForLeaseResult);
    const client: HostedControlPlaneClient = { registerRunner, pollForLease };

    const outcome = await runOneJobRunner(client, { ...BASE_CONFIG, now: () => 0, sleep: vi.fn() });

    expect(registerRunner).toHaveBeenCalledWith({ runnerId: 'runner-1', capabilities: ['git', 'node'] });
    expect(pollForLease).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ leased: true, jobId: 'job-1', attempts: 1 });
    expect(outcome.lease).toEqual(lease);
    expect(outcome.job).toEqual(job);
  });

  it('polls again after a no-match, and leases once a compatible job shows up', async () => {
    const job = fakeSummary();
    const lease = fakeLease();
    const pollForLease = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, reason: 'no-match' } satisfies PollForLeaseResult)
      .mockResolvedValueOnce({ ok: false, reason: 'no-match' } satisfies PollForLeaseResult)
      .mockResolvedValueOnce({ ok: true, lease, job } satisfies PollForLeaseResult);
    const client: HostedControlPlaneClient = {
      registerRunner: vi.fn().mockResolvedValue(fakeRunner()),
      pollForLease,
    };

    let now = 0;
    const sleep = vi.fn().mockImplementation(async (ms: number) => {
      now += ms;
    });

    const outcome = await runOneJobRunner(client, {
      ...BASE_CONFIG,
      timeoutMs: 30_000,
      pollIntervalMs: 2_000,
      now: () => now,
      sleep,
    });

    expect(pollForLease).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(outcome).toMatchObject({ leased: true, jobId: 'job-1', attempts: 3 });
  });

  it('exits cleanly with leased:false once the bounded wait window elapses with no compatible job', async () => {
    const pollForLease = vi.fn().mockResolvedValue({ ok: false, reason: 'no-match' } satisfies PollForLeaseResult);
    const client: HostedControlPlaneClient = {
      registerRunner: vi.fn().mockResolvedValue(fakeRunner()),
      pollForLease,
    };

    let now = 0;
    const sleep = vi.fn().mockImplementation(async (ms: number) => {
      now += ms;
    });

    const outcome = await runOneJobRunner(client, {
      ...BASE_CONFIG,
      timeoutMs: 5_000,
      pollIntervalMs: 2_000,
      now: () => now,
      sleep,
    });

    expect(outcome.leased).toBe(false);
    expect(outcome.jobId).toBeUndefined();
    expect(outcome.trace).toMatch(/no compatible job within 5000ms/);
    // Bounded: stops polling once the deadline has passed, not indefinitely.
    expect(pollForLease.mock.calls.length).toBeLessThanOrEqual(4);
  });
});

describe('createHttpHostedControlPlaneClient', () => {
  function fakeFetch(
    handler: (url: string, init?: { method?: string; body?: string }) => { ok: boolean; status: number; json: unknown },
  ): HostedControlPlaneFetchFn {
    return async (url, init) => {
      const { ok, status, json } = handler(url, init);
      return { ok, status, json: async () => json };
    };
  }

  it('POSTs registration to /runners and returns the parsed runner', async () => {
    const runner = fakeRunner();
    const fetchImpl = fakeFetch((url, init) => {
      expect(url).toBe('http://127.0.0.1:8799/runners');
      expect(init?.method).toBe('POST');
      expect(JSON.parse(init?.body ?? '{}')).toEqual({ runnerId: 'runner-1', capabilities: ['git', 'node'] });
      return { ok: true, status: 201, json: { runner } };
    });
    const client = createHttpHostedControlPlaneClient({ baseUrl: 'http://127.0.0.1:8799/', fetchImpl });

    const result = await client.registerRunner({ runnerId: 'runner-1', capabilities: ['git', 'node'] });
    expect(result).toEqual(runner);
  });

  it('POSTs to /runners/:id/poll and returns a no-match result', async () => {
    const fetchImpl = fakeFetch((url, init) => {
      expect(url).toBe('http://127.0.0.1:8799/runners/runner-1/poll');
      expect(JSON.parse(init?.body ?? '{}')).toEqual({
        capabilities: ['git'],
        leaseId: 'lease-1',
        ttlMs: 60_000,
        heartbeatIntervalMs: 5_000,
      });
      return { ok: true, status: 200, json: { ok: false, reason: 'no-match' } };
    });
    const client = createHttpHostedControlPlaneClient({ baseUrl: 'http://127.0.0.1:8799', fetchImpl });

    const result = await client.pollForLease({
      runnerId: 'runner-1',
      capabilities: ['git'],
      leaseId: 'lease-1',
      ttlMs: 60_000,
      heartbeatIntervalMs: 5_000,
    });
    expect(result).toEqual({ ok: false, reason: 'no-match' });
  });

  it('throws with the server-provided error message on a non-ok response', async () => {
    const fetchImpl = fakeFetch(() => ({ ok: false, status: 400, json: { error: 'boom' } }));
    const client = createHttpHostedControlPlaneClient({ baseUrl: 'http://127.0.0.1:8799', fetchImpl });

    await expect(client.registerRunner({ runnerId: 'runner-1', capabilities: [] })).rejects.toThrow(/boom/);
  });
});
