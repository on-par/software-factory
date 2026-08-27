// src/hosted/control-plane.ts — Minimal local HTTP control-plane API over the
// in-memory HostedJobStore (#924, parent #895/#896). Proves the hosted-exec
// server/client split with a pure request router plus a thin node:http
// wrapper: create a job, inspect it, list its events and result, and cancel
// it. Off by default (gated by FACTORY_HOSTED_EXEC via hostedExecEnabled),
// secret-redacted (responses only ever serialize summarizeHostedJob output
// and the store's already-redacted events/result), no persistence, no auth.
//
// Manual smoke: `FACTORY_HOSTED_EXEC=1` then start the server and
// `curl -XPOST localhost:8799/jobs -d '{"repoSlug":"on-par/software-factory","taskPayload":"smoke","requiredCapabilities":["git"],"requiredAuthority":"repo:write"}'`
// followed by `curl localhost:8799/jobs/<id>`.

import { randomUUID } from 'node:crypto';
import http from 'node:http';

import { hostedExecEnabled } from '@on-par/contracts';
import { z } from 'zod';

import { summarizeHostedJob } from './summary.js';
import type { HostedJobStore } from './store.js';

const CreateJobBodySchema = z.object({
  jobId: z.string().min(1).optional(),
  repoSlug: z.string().min(1),
  taskPayload: z.string().min(1),
  requiredCapabilities: z.array(z.string().min(1)),
  requiredAuthority: z.string().min(1),
});

export interface ControlPlaneResponse {
  status: number;
  body: unknown;
}

export interface HostedControlPlaneOptions {
  store: HostedJobStore;
  /** Defaults to process.env. Gate check reads FACTORY_HOSTED_EXEC from this. */
  env?: NodeJS.ProcessEnv;
  /** Default 8799; pass 0 in tests for an ephemeral port. */
  port?: number;
  /** Default '127.0.0.1' — never anything else in production code paths. */
  host?: string;
  /** Default randomUUID(); injectable for deterministic tests. */
  generateJobId?: () => string;
}

export interface HostedControlPlaneServer {
  server: http.Server;
  /** Actual bound port after start() resolves. */
  port: number;
  start(): Promise<number>;
  stop(): Promise<void>;
}

interface HostedControlPlaneRequest {
  method: string;
  pathname: string;
  body: unknown;
  generateJobId: () => string;
}

const JOB_PATH_PATTERN = /^\/jobs\/([^/]+)(?:\/(events|result|cancel))?$/;

/** Pure router: no I/O, no clock — everything comes from the injected store
 * and request shape. Responses only ever contain summarizeHostedJob output
 * and the store's already-redacted events/result, never raw secrets. */
export function handleHostedControlPlaneRequest(
  store: HostedJobStore,
  request: HostedControlPlaneRequest,
): ControlPlaneResponse {
  const { method, pathname, body, generateJobId } = request;

  if (pathname === '/jobs') {
    if (method !== 'POST') {
      return { status: 405, body: { error: 'method not allowed' } };
    }
    const parsed = CreateJobBodySchema.safeParse(body);
    if (!parsed.success) {
      return { status: 400, body: { error: parsed.error.message } };
    }
    const jobId = parsed.data.jobId ?? generateJobId();
    try {
      const job = store.create({ ...parsed.data, jobId });
      return { status: 201, body: { job: summarizeHostedJob(job) } };
    } catch (error) {
      return { status: 409, body: { error: (error as Error).message } };
    }
  }

  const match = JOB_PATH_PATTERN.exec(pathname);
  if (!match) {
    return { status: 404, body: { error: 'not found' } };
  }
  const [, jobId, subresource] = match;

  if (subresource === 'cancel') {
    if (method !== 'POST') {
      return { status: 405, body: { error: 'method not allowed' } };
    }
    const result = store.cancel(jobId, 'operator requested cancellation via control plane');
    if (!result.ok) {
      return { status: 404, body: { error: 'job not found' } };
    }
    return {
      status: 200,
      body: { jobId, status: result.job.request.status, alreadyTerminal: result.alreadyTerminal },
    };
  }

  if (method !== 'GET') {
    return { status: 405, body: { error: 'method not allowed' } };
  }

  const job = store.get(jobId);
  if (!job) {
    return { status: 404, body: { error: 'job not found' } };
  }

  if (subresource === 'events') {
    return { status: 200, body: { events: job.events } };
  }
  if (subresource === 'result') {
    return { status: 200, body: { result: job.result } };
  }
  return { status: 200, body: { job: summarizeHostedJob(job) } };
}

function readJsonBody(req: http.IncomingMessage): Promise<{ ok: true; value: unknown } | { ok: false }> {
  return new Promise((resolvePromise) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('error', () => resolvePromise({ ok: false }));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf-8');
      if (!text) {
        resolvePromise({ ok: true, value: {} });
        return;
      }
      try {
        resolvePromise({ ok: true, value: JSON.parse(text) });
      } catch {
        resolvePromise({ ok: false });
      }
    });
  });
}

/** Constructs the http.Server wrapper. Throws synchronously (start() never
 * binds) when FACTORY_HOSTED_EXEC is not '1' — construction, not just
 * start(), fails closed. */
export function createHostedControlPlaneServer(options: HostedControlPlaneOptions): HostedControlPlaneServer {
  const env = options.env ?? process.env;
  if (!hostedExecEnabled(env)) {
    throw new Error('hosted-exec control plane refused to start: set FACTORY_HOSTED_EXEC=1 to enable');
  }
  const { store } = options;
  const desiredPort = options.port ?? 8799;
  const host = options.host ?? '127.0.0.1';
  const generateJobId = options.generateJobId ?? (() => randomUUID());

  const server = http.createServer((req, res) => {
    void (async () => {
      const method = req.method ?? 'GET';
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;

      let body: unknown = {};
      if (method === 'POST') {
        const parsed = await readJsonBody(req);
        if (!parsed.ok) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid json body' }));
          return;
        }
        body = parsed.value;
      }

      const response = handleHostedControlPlaneRequest(store, { method, pathname, body, generateJobId });
      res.writeHead(response.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(response.body));
    })();
  });

  const controlPlane: HostedControlPlaneServer = {
    server,
    port: desiredPort,
    start(): Promise<number> {
      return new Promise((resolvePromise, reject) => {
        const onError = (err: Error) => {
          server.off('listening', onListening);
          reject(err);
        };
        const onListening = () => {
          server.off('error', onError);
          const addr = server.address();
          controlPlane.port = addr && typeof addr === 'object' ? addr.port : desiredPort;
          resolvePromise(controlPlane.port);
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen({ port: desiredPort, host, exclusive: true });
      });
    },
    stop(): Promise<void> {
      return new Promise((resolvePromise) => {
        server.closeAllConnections();
        server.close(() => resolvePromise());
      });
    },
  };

  return controlPlane;
}
