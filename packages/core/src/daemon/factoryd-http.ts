// src/daemon/factoryd-http.ts — The factoryd control-plane HTTP server: a
// loopback-only origin server over the repo registry (~/.factory/registry.json).
// GET /repos lists it (#777); POST /repos attaches a local checkout through the
// attachRepo precondition gate (#778); POST /repos/<owner>/<name>/pause|resume
// toggle an attached entry's state through setRepoState (#779); DELETE
// /repos/<owner>/<name>[?force=true] begins a drain-based detach through
// beginDetach + the background drainAndDetach loop (#780, epic #761). Binding
// to 127.0.0.1 IS the authorization model; see the ADR shipped with this
// change.

import http from 'node:http';

import { type AttachRepoDeps, attachRepo } from './repos-attach.js';
import { beginDetach, type DetachRepoDeps, drainAndDetach } from './repos-detach.js';
import { setRepoState } from './repos-pause-resume.js';
import { defaultRegistryPath, listRepos, loadRegistry, type RepoRegistryListing } from './registry.js';

/** Default TCP port for the foreground factoryd listener. */
export const DEFAULT_FACTORYD_PORT = 8787;

/** POST /repos body cap — attach requests are a couple of short strings; 64
 *  KiB is generous headroom while still bounding the read. */
const MAX_ATTACH_BODY_BYTES = 64 * 1024;

export interface FactorydOptions {
  /** Registry file to serve. Defaults to defaultRegistryPath(). */
  registryFile?: string;
  /** Default DEFAULT_FACTORYD_PORT; pass 0 in tests for an ephemeral port. */
  port?: number;
  /** Default '127.0.0.1' — never anything else in production code paths. */
  host?: string;
  /** One line per handled request. Default console.log; injectable for tests. */
  log?: (line: string) => void;
  /** Seams passed through to attachRepo for POST /repos. Test-only. */
  attachDeps?: AttachRepoDeps;
  /** Seams passed through to drainAndDetach for DELETE /repos/<owner>/<name>. Test-only. */
  detachDeps?: DetachRepoDeps;
}

type ReadJsonBodyResult = { ok: true; value: unknown } | { ok: false; tooLarge: boolean };

/** Streams `req` under `limit` bytes and JSON.parses it. Once the cap is
 *  exceeded the promise settles immediately with `tooLarge: true`, but the
 *  stream keeps draining (rather than destroying the socket) so the caller
 *  can still write a 413 response on the same connection. Resolves
 *  `tooLarge: false` on a parse error, an empty body, or a stream error — so
 *  an aborted upload can never leave the promise pending. */
function readJsonBody(req: http.IncomingMessage, limit: number): Promise<ReadJsonBodyResult> {
  return new Promise((resolvePromise) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const finish = (result: ReadJsonBodyResult) => {
      if (settled) return;
      settled = true;
      resolvePromise(result);
    };

    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > limit) {
        finish({ ok: false, tooLarge: true });
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', () => finish({ ok: false, tooLarge: false }));
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf-8');
        if (!text) throw new Error('empty body');
        finish({ ok: true, value: JSON.parse(text) });
      } catch {
        finish({ ok: false, tooLarge: false });
      }
    });
  });
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

/** `?force=true` (and the bare `?force`) enable the force path; every other
 *  value — absent, `false`, `0`, `1` — is a normal drain, so the safe default
 *  is what an unrecognized value gets. */
function parseForce(url: string | undefined): boolean {
  const query = (url ?? '').split('?')[1];
  if (query === undefined) return false;
  const value = new URLSearchParams(query).get('force');
  return value !== null && (value === '' || value.toLowerCase() === 'true');
}

export function createFactorydServer(opts: FactorydOptions = {}): FactorydServer {
  const registryFile = opts.registryFile ?? defaultRegistryPath();
  const desiredPort = opts.port ?? DEFAULT_FACTORYD_PORT;
  const host = opts.host ?? '127.0.0.1';
  const log = opts.log ?? ((line: string) => console.log(line));

  // Server-scoped drain bookkeeping: the signal lets stop() cooperatively
  // abort every in-flight drainAndDetach loop, and pendingDrains is what
  // stop() awaits so no poll timer outlives the server.
  const drainSignal = { aborted: false };
  const pendingDrains = new Set<Promise<unknown>>();

  function send(
    res: http.ServerResponse,
    req: http.IncomingMessage,
    status: number,
    payload: unknown,
    allow = 'GET, POST',
  ): void {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (status === 405) headers.allow = allow;
    res.writeHead(status, headers);
    res.end(JSON.stringify(payload));
    log(`${req.method ?? '-'} ${parsePathname(req.url)} ${status}`);
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const pathname = parsePathname(req.url);

    if (pathname === '/repos') {
      if (req.method === 'GET') {
        const registry = await loadRegistry(registryFile);
        send(res, req, 200, { repos: listRepos(registry) satisfies RepoRegistryListing[] });
        return;
      }

      if (req.method === 'POST') {
        const body = await readJsonBody(req, MAX_ATTACH_BODY_BYTES);
        if (!body.ok) {
          send(res, req, body.tooLarge ? 413 : 400, {
            error: body.tooLarge ? 'request body too large' : 'invalid JSON body',
            reason: 'invalid-request',
          });
          return;
        }
        const result = await attachRepo(registryFile, body.value, opts.attachDeps);
        if (!result.ok) {
          send(res, req, 400, { error: result.detail, reason: result.reason });
          return;
        }
        send(res, req, 201, { repo: result.entry });
        return;
      }

      send(res, req, 405, { error: 'method not allowed' });
      return;
    }

    const segments = pathname.split('/').filter((s) => s.length > 0);
    if (segments.length === 4 && segments[0] === 'repos' && (segments[3] === 'pause' || segments[3] === 'resume')) {
      if (req.method !== 'POST') {
        send(res, req, 405, { error: 'method not allowed' }, 'POST');
        return;
      }
      const slug = `${segments[1]}/${segments[2]}`;
      const result = await setRepoState(registryFile, slug, segments[3] === 'pause' ? 'paused' : 'active');
      if (!result.ok) {
        send(res, req, result.reason === 'detached' ? 409 : 404, { error: result.detail, reason: result.reason });
        return;
      }
      send(res, req, 200, { repo: result.entry });
      return;
    }

    if (segments.length === 3 && segments[0] === 'repos') {
      if (req.method !== 'DELETE') {
        send(res, req, 405, { error: 'method not allowed' }, 'DELETE');
        return;
      }
      const slug = `${segments[1]}/${segments[2]}`;
      const force = parseForce(req.url);
      const result = await beginDetach(registryFile, slug, force);
      if (!result.ok) {
        send(res, req, 404, { error: result.detail, reason: result.reason });
        return;
      }
      if (result.draining) {
        const drain = drainAndDetach(registryFile, slug, { ...opts.detachDeps, signal: drainSignal })
          .catch((err: unknown) => {
            log(`drain failed for ${slug}: ${err instanceof Error ? err.message : String(err)}`);
            return undefined;
          })
          .finally(() => pendingDrains.delete(drain));
        pendingDrains.add(drain);
        send(res, req, 202, { repo: result.entry });
        return;
      }
      send(res, req, 200, { repo: result.entry });
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
        log(`${req.method ?? '-'} ${parsePathname(req.url)} ${res.statusCode}`);
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
    async stop(): Promise<void> {
      drainSignal.aborted = true;
      await Promise.allSettled([...pendingDrains]);
      await new Promise<void>((resolvePromise) => {
        server.closeAllConnections();
        server.close(() => resolvePromise());
      });
    },
  };

  return factoryd;
}
