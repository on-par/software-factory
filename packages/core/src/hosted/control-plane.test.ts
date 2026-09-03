import http from 'node:http';

import { describe, expect, it } from 'vitest';

import { createHostedJobStore, type HostedJobStore } from './store.js';
import {
  createHostedControlPlaneServer,
  handleHostedControlPlaneRequest,
  type HostedControlPlaneServer,
} from './control-plane.js';

const NOW = 1_700_000_000_000;
const GENERATE_JOB_ID = () => 'job-1';

const VALID_BODY = {
  repoSlug: 'on-par/software-factory',
  taskPayload: 'ship it',
  requiredCapabilities: ['git'],
  requiredAuthority: 'repo:write',
};

function newStore(): HostedJobStore {
  return createHostedJobStore({ now: () => NOW });
}

describe('handleHostedControlPlaneRequest', () => {
  it('rejects an invalid POST /jobs body with 400', () => {
    const store = newStore();
    const response = handleHostedControlPlaneRequest(store, {
      method: 'POST',
      pathname: '/jobs',
      body: { repoSlug: '' },
      generateJobId: GENERATE_JOB_ID,
    });
    expect(response.status).toBe(400);
  });

  it('creates a job on POST /jobs and reads it back via GET /jobs/:id', () => {
    const store = newStore();
    const created = handleHostedControlPlaneRequest(store, {
      method: 'POST',
      pathname: '/jobs',
      body: VALID_BODY,
      generateJobId: GENERATE_JOB_ID,
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ job: { jobId: 'job-1', status: 'requested' } });

    const fetched = handleHostedControlPlaneRequest(store, {
      method: 'GET',
      pathname: '/jobs/job-1',
      body: undefined,
      generateJobId: GENERATE_JOB_ID,
    });
    expect(fetched.status).toBe(200);
    expect(fetched.body).toMatchObject({
      job: { status: 'requested', lastEvent: { type: 'requested' } },
    });
  });

  it('honors an explicit jobId and returns 409 on duplicate creation', () => {
    const store = newStore();
    const first = handleHostedControlPlaneRequest(store, {
      method: 'POST',
      pathname: '/jobs',
      body: { ...VALID_BODY, jobId: 'explicit-id' },
      generateJobId: GENERATE_JOB_ID,
    });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ job: { jobId: 'explicit-id' } });

    const duplicate = handleHostedControlPlaneRequest(store, {
      method: 'POST',
      pathname: '/jobs',
      body: { ...VALID_BODY, jobId: 'explicit-id' },
      generateJobId: GENERATE_JOB_ID,
    });
    expect(duplicate.status).toBe(409);
  });

  it('returns 404 for GET /jobs/:id on an unknown job', () => {
    const store = newStore();
    const response = handleHostedControlPlaneRequest(store, {
      method: 'GET',
      pathname: '/jobs/does-not-exist',
      body: undefined,
      generateJobId: GENERATE_JOB_ID,
    });
    expect(response.status).toBe(404);
  });

  it('lists events on GET /jobs/:id/events and 404s for an unknown job', () => {
    const store = newStore();
    handleHostedControlPlaneRequest(store, {
      method: 'POST',
      pathname: '/jobs',
      body: VALID_BODY,
      generateJobId: GENERATE_JOB_ID,
    });

    const events = handleHostedControlPlaneRequest(store, {
      method: 'GET',
      pathname: '/jobs/job-1/events',
      body: undefined,
      generateJobId: GENERATE_JOB_ID,
    });
    expect(events.status).toBe(200);
    expect(events.body).toMatchObject({ events: [{ type: 'requested' }] });

    const missing = handleHostedControlPlaneRequest(store, {
      method: 'GET',
      pathname: '/jobs/does-not-exist/events',
      body: undefined,
      generateJobId: GENERATE_JOB_ID,
    });
    expect(missing.status).toBe(404);
  });

  it('returns a null result until terminal on GET /jobs/:id/result and 404s for an unknown job', () => {
    const store = newStore();
    handleHostedControlPlaneRequest(store, {
      method: 'POST',
      pathname: '/jobs',
      body: VALID_BODY,
      generateJobId: GENERATE_JOB_ID,
    });

    const result = handleHostedControlPlaneRequest(store, {
      method: 'GET',
      pathname: '/jobs/job-1/result',
      body: undefined,
      generateJobId: GENERATE_JOB_ID,
    });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ result: null });

    const missing = handleHostedControlPlaneRequest(store, {
      method: 'GET',
      pathname: '/jobs/does-not-exist/result',
      body: undefined,
      generateJobId: GENERATE_JOB_ID,
    });
    expect(missing.status).toBe(404);
  });

  it('cancels a live job, is idempotent on a second cancel, and 404s an unknown job', () => {
    const store = newStore();
    handleHostedControlPlaneRequest(store, {
      method: 'POST',
      pathname: '/jobs',
      body: VALID_BODY,
      generateJobId: GENERATE_JOB_ID,
    });

    const first = handleHostedControlPlaneRequest(store, {
      method: 'POST',
      pathname: '/jobs/job-1/cancel',
      body: undefined,
      generateJobId: GENERATE_JOB_ID,
    });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ jobId: 'job-1', status: 'canceled', alreadyTerminal: false });

    const second = handleHostedControlPlaneRequest(store, {
      method: 'POST',
      pathname: '/jobs/job-1/cancel',
      body: undefined,
      generateJobId: GENERATE_JOB_ID,
    });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ alreadyTerminal: true });

    const missing = handleHostedControlPlaneRequest(store, {
      method: 'POST',
      pathname: '/jobs/does-not-exist/cancel',
      body: undefined,
      generateJobId: GENERATE_JOB_ID,
    });
    expect(missing.status).toBe(404);
  });

  it('returns 404 for an unmatched path and 405 for a known path with the wrong method', () => {
    const store = newStore();
    expect(
      handleHostedControlPlaneRequest(store, {
        method: 'GET',
        pathname: '/nope',
        body: undefined,
        generateJobId: GENERATE_JOB_ID,
      }).status,
    ).toBe(404);
    expect(
      handleHostedControlPlaneRequest(store, {
        method: 'GET',
        pathname: '/jobs',
        body: undefined,
        generateJobId: GENERATE_JOB_ID,
      }).status,
    ).toBe(405);
  });

  it('serializes only the summarized job, never the raw stored record (e.g. the internal lease)', () => {
    const store = newStore();
    handleHostedControlPlaneRequest(store, {
      method: 'POST',
      pathname: '/jobs',
      body: VALID_BODY,
      generateJobId: GENERATE_JOB_ID,
    });
    const lease = store.acquireLease({
      jobId: 'job-1',
      runnerId: 'runner-1',
      leaseId: 'lease-1',
      ttlMs: 60_000,
      heartbeatIntervalMs: 5_000,
    });
    expect(lease.ok).toBe(true);

    const fetched = handleHostedControlPlaneRequest(store, {
      method: 'GET',
      pathname: '/jobs/job-1',
      body: undefined,
      generateJobId: GENERATE_JOB_ID,
    });

    // summarizeHostedJob exposes only operator-facing fields; it never
    // forwards the raw StoredHostedJob (which carries the internal `lease`).
    expect(fetched.body).toMatchObject({ job: { jobId: 'job-1' } });
    expect(fetched.body).not.toHaveProperty('job.lease');
    expect(Object.keys((fetched.body as { job: object }).job)).not.toContain('lease');
  });

  it('registers a runner on POST /runners and rejects an invalid body with 400', () => {
    const store = newStore();
    const registered = handleHostedControlPlaneRequest(store, {
      method: 'POST',
      pathname: '/runners',
      body: { runnerId: 'runner-1', capabilities: ['git', 'node'] },
      generateJobId: GENERATE_JOB_ID,
    });
    expect(registered.status).toBe(201);
    expect(registered.body).toMatchObject({
      runner: { runnerId: 'runner-1', capabilities: ['git', 'node'], available: true },
    });

    const invalid = handleHostedControlPlaneRequest(store, {
      method: 'POST',
      pathname: '/runners',
      body: { runnerId: '' },
      generateJobId: GENERATE_JOB_ID,
    });
    expect(invalid.status).toBe(400);

    expect(
      handleHostedControlPlaneRequest(store, {
        method: 'GET',
        pathname: '/runners',
        body: undefined,
        generateJobId: GENERATE_JOB_ID,
      }).status,
    ).toBe(405);
  });

  it('leases a compatible job on POST /runners/:id/poll and surfaces it as owned by the runner', () => {
    const store = newStore();
    handleHostedControlPlaneRequest(store, {
      method: 'POST',
      pathname: '/jobs',
      body: VALID_BODY,
      generateJobId: GENERATE_JOB_ID,
    });

    const poll = handleHostedControlPlaneRequest(store, {
      method: 'POST',
      pathname: '/runners/runner-1/poll',
      body: { capabilities: ['git', 'node'], leaseId: 'lease-1', ttlMs: 60_000, heartbeatIntervalMs: 5_000 },
      generateJobId: GENERATE_JOB_ID,
    });
    expect(poll.status).toBe(200);
    expect(poll.body).toMatchObject({
      ok: true,
      lease: { runnerId: 'runner-1', leaseId: 'lease-1', jobId: 'job-1' },
      job: { jobId: 'job-1', status: 'leased', leasedBy: 'runner-1' },
    });

    const fetched = handleHostedControlPlaneRequest(store, {
      method: 'GET',
      pathname: '/jobs/job-1',
      body: undefined,
      generateJobId: GENERATE_JOB_ID,
    });
    expect(fetched.body).toMatchObject({ job: { leasedBy: 'runner-1' } });
  });

  it('returns ok:false no-match on POST /runners/:id/poll with no compatible job, and 400/405 for bad requests', () => {
    const store = newStore();
    const poll = handleHostedControlPlaneRequest(store, {
      method: 'POST',
      pathname: '/runners/runner-1/poll',
      body: { capabilities: ['git'], leaseId: 'lease-1', ttlMs: 60_000, heartbeatIntervalMs: 5_000 },
      generateJobId: GENERATE_JOB_ID,
    });
    expect(poll.status).toBe(200);
    expect(poll.body).toEqual({ ok: false, reason: 'no-match' });

    expect(
      handleHostedControlPlaneRequest(store, {
        method: 'POST',
        pathname: '/runners/runner-1/poll',
        body: { capabilities: ['git'] },
        generateJobId: GENERATE_JOB_ID,
      }).status,
    ).toBe(400);

    expect(
      handleHostedControlPlaneRequest(store, {
        method: 'GET',
        pathname: '/runners/runner-1/poll',
        body: undefined,
        generateJobId: GENERATE_JOB_ID,
      }).status,
    ).toBe(405);
  });
});

describe('createHostedControlPlaneServer', () => {
  it('throws with a message naming FACTORY_HOSTED_EXEC when the gate is closed', () => {
    const store = newStore();
    expect(() => createHostedControlPlaneServer({ store, env: {} })).toThrow(/FACTORY_HOSTED_EXEC/);
  });

  it('constructs, starts, and stops when the gate is open', async () => {
    const store = newStore();
    const controlPlane = createHostedControlPlaneServer({
      store,
      env: { FACTORY_HOSTED_EXEC: '1' },
      port: 0,
    });
    const port = await controlPlane.start();
    expect(port).toBeGreaterThan(0);
    await controlPlane.stop();
  });

  it('round-trips a create + fetch over a real socket with JSON content-type', async () => {
    const store = newStore();
    let controlPlane: HostedControlPlaneServer | undefined;
    try {
      controlPlane = createHostedControlPlaneServer({
        store,
        env: { FACTORY_HOSTED_EXEC: '1' },
        port: 0,
        generateJobId: GENERATE_JOB_ID,
      });
      const port = await controlPlane.start();

      const created = await request(port, 'POST', '/jobs', VALID_BODY);
      expect(created.status).toBe(201);
      expect(created.headers['content-type']).toBe('application/json');
      expect(JSON.parse(created.body)).toMatchObject({ job: { jobId: 'job-1' } });

      const fetched = await request(port, 'GET', '/jobs/job-1');
      expect(fetched.status).toBe(200);
      expect(JSON.parse(fetched.body)).toMatchObject({ job: { jobId: 'job-1' } });

      const malformed = await request(port, 'POST', '/jobs', undefined, '{not json');
      expect(malformed.status).toBe(400);
    } finally {
      await controlPlane?.stop();
    }
  });

  it('round-trips runner registration and poll-for-lease over a real socket', async () => {
    const store = newStore();
    let controlPlane: HostedControlPlaneServer | undefined;
    try {
      controlPlane = createHostedControlPlaneServer({
        store,
        env: { FACTORY_HOSTED_EXEC: '1' },
        port: 0,
        generateJobId: GENERATE_JOB_ID,
      });
      const port = await controlPlane.start();

      await request(port, 'POST', '/jobs', VALID_BODY);

      const registered = await request(port, 'POST', '/runners', { runnerId: 'runner-1', capabilities: ['git'] });
      expect(registered.status).toBe(201);
      expect(JSON.parse(registered.body)).toMatchObject({ runner: { runnerId: 'runner-1' } });

      const leased = await request(port, 'POST', '/runners/runner-1/poll', {
        capabilities: ['git'],
        leaseId: 'lease-1',
        ttlMs: 60_000,
        heartbeatIntervalMs: 5_000,
      });
      expect(leased.status).toBe(200);
      expect(JSON.parse(leased.body)).toMatchObject({ ok: true, job: { jobId: 'job-1', leasedBy: 'runner-1' } });
    } finally {
      await controlPlane?.stop();
    }
  });
});

function request(
  port: number,
  method: string,
  path: string,
  jsonBody?: unknown,
  rawBody?: string,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolvePromise, reject) => {
    const payload = rawBody ?? (jsonBody === undefined ? undefined : JSON.stringify(jsonBody));
    const headers: Record<string, string> = {};
    if (payload !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(Buffer.byteLength(payload));
    }
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolvePromise({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}
