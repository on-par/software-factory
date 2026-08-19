// packages/server/src/index.ts — Local HTTP server for the factory: exposes the lane
// lifecycle bus (#591) as a Server-Sent Events stream on GET /events. Loopback-only,
// unauthenticated by design (see ADR "SSE resume is a bounded in-process replay ring").
import http from 'node:http';

import type { LaneLifecycleEvent } from '@on-par/contracts';

import { createReplayRing, formatSseFrame, parseLastEventId } from './sse.js';

export const SERVER_VERSION = '0.1.0';

/** Structural port over core's `LifecycleBus` — server never imports core. */
export interface LifecycleEventSource {
  on(listener: (event: LaneLifecycleEvent) => void): () => void;
}

export interface ServerConfig {
  /** The lane lifecycle bus to relay — pass core's `lifecycleBus` or `createLifecycleBus()`. */
  bus: LifecycleEventSource;
  /** Default 8787; pass 0 in tests for an ephemeral port. */
  port?: number;
  /** Default '127.0.0.1' — never anything else in production code paths. */
  host?: string;
  /** Events retained for `Last-Event-ID` replay. Default 256. */
  replayBufferSize?: number;
  /** Comment-heartbeat interval in ms. Default 15_000; 0 disables. */
  heartbeatMs?: number;
}

export interface FactoryServer {
  server: http.Server;
  /** Actual bound port after start() resolves. */
  port: number;
  start(): Promise<number>;
  stop(): Promise<void>;
}

export function createServer(config: ServerConfig): FactoryServer {
  const host = config.host ?? '127.0.0.1';
  const desiredPort = config.port ?? 8787;
  const ring = createReplayRing(config.replayBufferSize ?? 256);
  const heartbeatMs = config.heartbeatMs ?? 15_000;

  let seq = 0;
  const clients = new Set<http.ServerResponse>();
  const timers = new Map<http.ServerResponse, NodeJS.Timeout>();
  let unsubscribe: (() => void) | undefined;
  let stopped = false;

  function handleEvents(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });

    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    res.write('retry: 2000\n\n');

    for (const entry of ring.since(parseLastEventId(req.headers['last-event-id']))) {
      res.write(formatSseFrame(entry.id, entry.event));
    }

    // A disconnected client's socket can still receive a write() queued before the
    // 'close' event lands; an unhandled 'error' there would crash the process.
    res.on('error', () => {});
    clients.add(res);

    if (heartbeatMs > 0) {
      const t = setInterval(() => res.write(': ping\n\n'), heartbeatMs);
      t.unref();
      timers.set(res, t);
    }

    req.on('close', () => {
      const t = timers.get(res);
      if (t) clearInterval(t);
      timers.delete(res);
      clients.delete(res);
    });
  }

  function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (pathname === '/events' && (req.method === 'GET' || req.method === 'HEAD')) {
      handleEvents(req, res);
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  }

  const server = http.createServer(handleRequest);

  const factoryServer: FactoryServer = {
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
          factoryServer.port = addr && typeof addr === 'object' ? addr.port : desiredPort;
          unsubscribe = config.bus.on((event) => {
            const id = ++seq;
            ring.push(id, event);
            const frame = formatSseFrame(id, event);
            for (const res of clients) res.write(frame);
          });
          resolvePromise(factoryServer.port);
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen({ port: desiredPort, host, exclusive: true });
      });
    },
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      unsubscribe?.();
      for (const t of timers.values()) clearInterval(t);
      timers.clear();
      for (const res of clients) res.end();
      clients.clear();
      server.closeAllConnections();
      await new Promise<void>((resolvePromise) => {
        server.close(() => resolvePromise());
      });
    },
  };

  return factoryServer;
}
