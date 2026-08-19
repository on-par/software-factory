// src/daemon/factoryd-http.ts — The factoryd control-plane HTTP server: a
// loopback-only origin server over the repo registry (~/.factory/registry.json).
// Read-only for now — GET /repos is the whole API (#777, epic #761). Binding to
// 127.0.0.1 IS the authorization model; see the ADR shipped with this change.

import http from 'node:http';

import { defaultRegistryPath, listRepos, loadRegistry } from './registry.js';

/** Default TCP port for the foreground factoryd listener. */
export const DEFAULT_FACTORYD_PORT = 8787;

export interface FactorydOptions {
  /** Registry file to serve. Defaults to defaultRegistryPath(). */
  registryFile?: string;
  /** Default DEFAULT_FACTORYD_PORT; pass 0 in tests for an ephemeral port. */
  port?: number;
  /** Default '127.0.0.1' — never anything else in production code paths. */
  host?: string;
  /** One line per handled request. Default console.log; injectable for tests. */
  log?: (line: string) => void;
}

export interface FactorydServer {
  server: http.Server;
  /** Actual bound port after start() resolves. */
  port: number;
  start(): Promise<number>;
  stop(): Promise<void>;
}

function parsePathname(url: string | undefined): string {
  const raw = (url ?? '/').split('?')[0] ?? '/';
  if (raw.length > 1 && raw.endsWith('/')) return raw.slice(0, -1);
  return raw;
}

export function createFactorydServer(opts: FactorydOptions = {}): FactorydServer {
  const registryFile = opts.registryFile ?? defaultRegistryPath();
  const desiredPort = opts.port ?? DEFAULT_FACTORYD_PORT;
  const host = opts.host ?? '127.0.0.1';
  const log = opts.log ?? ((line: string) => console.log(line));

  function send(res: http.ServerResponse, req: http.IncomingMessage, status: number, payload: unknown): void {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (status === 405) headers.allow = 'GET';
    res.writeHead(status, headers);
    res.end(JSON.stringify(payload));
    log(`${req.method ?? '-'} ${parsePathname(req.url)} ${status}`);
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const pathname = parsePathname(req.url);

    if (pathname === '/repos') {
      if (req.method !== 'GET') {
        send(res, req, 405, { error: 'method not allowed' });
        return;
      }
      const registry = await loadRegistry(registryFile);
      send(res, req, 200, { repos: listRepos(registry) });
      return;
    }

    send(res, req, 404, { error: 'not found' });
  }

  const server = http.createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) {
        send(res, req, 500, { error: 'internal error' });
      } else {
        res.end();
      }
    });
  });

  const factoryd: FactorydServer = {
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
          factoryd.port = addr && typeof addr === 'object' ? addr.port : desiredPort;
          resolvePromise(factoryd.port);
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

  return factoryd;
}
