import { describe, expect, it, vi } from 'vitest';

import type { HostedJobEvent } from '@on-par/contracts';

import type { HostedJobSummary } from './summary.js';
import { createHttpHostedJobClient, queueAndTailJob, type HostedJobClient } from './queue-client.js';
import type { HostedControlPlaneFetchFn } from './runner-client.js';

function fakeSummary(overrides: Partial<HostedJobSummary> = {}): HostedJobSummary {
  return {
    jobId: 'job-1',
    repoSlug: 'on-par/software-factory',
    status: 'requested',
    leasedBy: null,
    outcome: null,
    summary: null,
    exitCode: null,
    failurePhase: null,
    eventCount: 0,
    lastEvent: null,
    artifacts: [],
    artifactCount: 0,
    logsTail: null,
    cleanupProof: null,
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function fakeEvent(overrides: Partial<HostedJobEvent> = {}): HostedJobEvent {
  return {
    jobId: 'job-1',
    type: 'requested',
    ts: '2026-01-01T00:00:00.000Z',
    severity: 'info',
    message: 'job requested',
    ...overrides,
  };
}

const BASE_CONFIG = {
  repoSlug: 'on-par/software-factory',
  taskPayload: 'do the thing',
  requiredCapabilities: ['git', 'node'],
  requiredAuthority: 'repo:read',
};

describe('queueAndTailJob', () => {
  it('returns immediately without polling when createJob already returns a terminal status', async () => {
    const summary = fakeSummary({ status: 'done', outcome: 'completed' });
    const events = [fakeEvent()];
    const createJob = vi.fn().mockResolvedValue(summary);
    const getJob = vi.fn();
    const getEvents = vi.fn().mockResolvedValue(events);
    const client: HostedJobClient = { createJob, getJob, getEvents };

    const outcome = await queueAndTailJob(client, { ...BASE_CONFIG, now: () => 0, sleep: vi.fn() });

    expect(createJob).toHaveBeenCalledWith({
      repoSlug: 'on-par/software-factory',
      taskPayload: 'do the thing',
      requiredCapabilities: ['git', 'node'],
      requiredAuthority: 'repo:read',
      jobId: undefined,
    });
    expect(getJob).not.toHaveBeenCalled();
    expect(getEvents).toHaveBeenCalledWith('job-1');
    expect(outcome).toEqual({
      jobId: 'job-1',
      terminal: true,
      status: 'done',
      summary,
      events,
      trace: 'queued job-1 -> done',
    });
  });

  it('polls getJob until a terminal status is reached', async () => {
    const createJob = vi.fn().mockResolvedValue(fakeSummary({ status: 'requested' }));
    const getJob = vi
      .fn()
      .mockResolvedValueOnce(fakeSummary({ status: 'running' }))
      .mockResolvedValueOnce(fakeSummary({ status: 'failed', outcome: 'failed' }));
    const getEvents = vi.fn().mockResolvedValue([]);
    const client: HostedJobClient = { createJob, getJob, getEvents };

    let now = 0;
    const sleep = vi.fn().mockImplementation(async (ms: number) => {
      now += ms;
    });

    const outcome = await queueAndTailJob(client, {
      ...BASE_CONFIG,
      timeoutMs: 30_000,
      pollIntervalMs: 1_000,
      now: () => now,
      sleep,
    });

    expect(getJob).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(outcome.terminal).toBe(true);
    expect(outcome.status).toBe('failed');
  });

  it('stops polling once the bounded wait window elapses without reaching a terminal status', async () => {
    const createJob = vi.fn().mockResolvedValue(fakeSummary({ status: 'requested' }));
    const getJob = vi.fn().mockResolvedValue(fakeSummary({ status: 'running' }));
    const getEvents = vi.fn().mockResolvedValue([]);
    const client: HostedJobClient = { createJob, getJob, getEvents };

    let now = 0;
    const sleep = vi.fn().mockImplementation(async (ms: number) => {
      now += ms;
    });

    const outcome = await queueAndTailJob(client, {
      ...BASE_CONFIG,
      timeoutMs: 5_000,
      pollIntervalMs: 2_000,
      now: () => now,
      sleep,
    });

    expect(outcome.terminal).toBe(false);
    expect(outcome.status).toBe('running');
    // Bounded: stops polling once the deadline has passed, not indefinitely.
    expect(getJob.mock.calls.length).toBeLessThanOrEqual(4);
  });
});

describe('createHttpHostedJobClient', () => {
  function fakeFetch(
    handler: (url: string, init?: { method?: string; body?: string }) => { ok: boolean; status: number; json: unknown },
  ): HostedControlPlaneFetchFn {
    return async (url, init) => {
      const { ok, status, json } = handler(url, init);
      return { ok, status, json: async () => json };
    };
  }

  it('POSTs to /jobs and returns the unwrapped job summary', async () => {
    const summary = fakeSummary();
    const fetchImpl = fakeFetch((url, init) => {
      expect(url).toBe('http://127.0.0.1:8799/jobs');
      expect(init?.method).toBe('POST');
      expect(JSON.parse(init?.body ?? '{}')).toEqual({
        repoSlug: 'on-par/software-factory',
        taskPayload: 'do the thing',
        requiredCapabilities: ['git'],
        requiredAuthority: 'repo:read',
        jobId: undefined,
      });
      return { ok: true, status: 201, json: { job: summary } };
    });
    const client = createHttpHostedJobClient({ baseUrl: 'http://127.0.0.1:8799/', fetchImpl });

    const result = await client.createJob({
      repoSlug: 'on-par/software-factory',
      taskPayload: 'do the thing',
      requiredCapabilities: ['git'],
      requiredAuthority: 'repo:read',
    });
    expect(result).toEqual(summary);
  });

  it('GETs /jobs/:id and returns the unwrapped job summary', async () => {
    const summary = fakeSummary({ status: 'running' });
    const fetchImpl = fakeFetch((url, init) => {
      expect(url).toBe('http://127.0.0.1:8799/jobs/job-1');
      expect(init?.method).toBe('GET');
      return { ok: true, status: 200, json: { job: summary } };
    });
    const client = createHttpHostedJobClient({ baseUrl: 'http://127.0.0.1:8799', fetchImpl });

    const result = await client.getJob('job-1');
    expect(result).toEqual(summary);
  });

  it('GETs /jobs/:id/events and returns the unwrapped event list', async () => {
    const events = [fakeEvent()];
    const fetchImpl = fakeFetch((url, init) => {
      expect(url).toBe('http://127.0.0.1:8799/jobs/job-1/events');
      expect(init?.method).toBe('GET');
      return { ok: true, status: 200, json: { events } };
    });
    const client = createHttpHostedJobClient({ baseUrl: 'http://127.0.0.1:8799', fetchImpl });

    const result = await client.getEvents('job-1');
    expect(result).toEqual(events);
  });

  it('throws with the request path and server-provided error message on a non-ok response', async () => {
    const fetchImpl = fakeFetch(() => ({ ok: false, status: 400, json: { error: 'boom' } }));
    const client = createHttpHostedJobClient({ baseUrl: 'http://127.0.0.1:8799', fetchImpl });

    await expect(
      client.createJob({ repoSlug: 'a/b', taskPayload: 't', requiredCapabilities: [], requiredAuthority: 'x' }),
    ).rejects.toThrow(/\/jobs failed: boom/);
    await expect(client.getJob('job-1')).rejects.toThrow(/\/jobs\/job-1 failed: boom/);
  });
});
