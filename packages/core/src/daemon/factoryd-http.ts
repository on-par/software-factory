// src/daemon/factoryd-http.ts — The factoryd control-plane HTTP server: a
// loopback-only origin server over the repo registry (~/.factory/registry.json).
// GET /repos lists it (#777); POST /repos attaches a local checkout through the
// attachRepo precondition gate (#778); POST /repos/<owner>/<name>/pause|resume
// toggle an attached entry's state through setRepoState (#779); DELETE
// /repos/<owner>/<name>[?force=true] begins a drain-based detach through
// beginDetach + the background drainAndDetach loop (#780, epic #761); GET/PUT
// /repos/<owner>/<name>/policy read and persist the SAFE_POLICY_FIELDS
// allow-list against the checkout's .factory/config.json (#1389, ADR-0094);
// POST /runs creates durable explicit runs and GET /runs/<id> reads them
// (#1393, ADR-0097); POST /self-fix files or reuses one guard-labelled self-fix
// issue for a fingerprint (#1392). Binding to 127.0.0.1 IS the authorization model; see the
// ADRs shipped with these changes.

import http from 'node:http';

import { getFactoryPaths, isPlainObject } from '../config/index.js';
import {
  isSafePolicyFieldId,
  policyConfirmationFor,
  resolveSafeRepoPolicy,
  setSafeRepoPolicyField,
} from '../config/policy.js';
import { type AttachRepoDeps, attachRepo } from './repos-attach.js';
import { createDaemonLaneContext } from './lane-context.js';
import { beginDetach, type DetachRepoDeps, drainAndDetach } from './repos-detach.js';
import { setRepoState } from './repos-pause-resume.js';
import { defaultRegistryPath, listRepos, loadRegistry, type RepoRegistryListing } from './registry.js';
import { daemonRunFile, isValidRunId, readDaemonRun } from './run-store.js';
import { type DaemonRunDeps, type DaemonRunExecutor, executeDaemonRun, submitDaemonRun } from './runs-submit.js';
import { type DaemonSelfFixDeps, submitDaemonSelfFix } from './self-fix-submit.js';
import type { FilingGitHubClient } from '../filing/index.js';
import { daemonRuntimePaths } from './runtime-state.js';
import { dirname } from 'node:path';

/** Default TCP port for the foreground factoryd listener. */
export const DEFAULT_FACTORYD_PORT = 8787;

/** POST request body cap — requests are a couple of short strings; 64
 *  KiB is generous headroom while still bounding the read. */
const MAX_REQUEST_BODY_BYTES = 64 * 1024;

export interface FactorydOptions {
  /** Registry file to serve. Defaults to defaultRegistryPath(). */
  registryFile?: string;
  /** Default daemonRuntimePaths(dirname(registryFile)).runsDir. */
  runsDir?: string;
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
  /** Engine port POST /runs dispatches to. Default rejects with the #1366 gap. */
  runExecutor?: DaemonRunExecutor;
  /** Seams passed through to submitDaemonRun/executeDaemonRun. Test-only. */
  runDeps?: DaemonRunDeps;
  /** GitHub port POST /self-fix files through. Unwired by default -> 503. */
  selfFixClient?: FilingGitHubClient;
  /** Seams passed through to submitDaemonSelfFix. Test-only. */
  selfFixDeps?: DaemonSelfFixDeps;
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
  const runsDir = opts.runsDir ?? daemonRuntimePaths(dirname(registryFile)).runsDir;
  const desiredPort = opts.port ?? DEFAULT_FACTORYD_PORT;
  const host = opts.host ?? '127.0.0.1';
  const log = opts.log ?? ((line: string) => console.log(line));
  const runExecutor =
    opts.runExecutor ?? (() => Promise.reject(new Error('no run executor wired into factoryd (#1366)')));
  const runDeps: DaemonRunDeps = { ...opts.runDeps, log: opts.runDeps?.log ?? log };

  // Server-scoped drain bookkeeping: the signal lets stop() cooperatively
  // abort every in-flight drainAndDetach loop, and pendingDrains is what
  // stop() awaits so no poll timer outlives the server.
  const drainSignal = { aborted: false };
  const pendingDrains = new Set<Promise<unknown>>();
  const pendingRuns = new Set<Promise<unknown>>();

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
        const body = await readJsonBody(req, MAX_REQUEST_BODY_BYTES);
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

    if (pathname === '/runs') {
      if (req.method !== 'POST') {
        send(res, req, 405, { error: 'method not allowed' }, 'POST');
        return;
      }
      const body = await readJsonBody(req, MAX_REQUEST_BODY_BYTES);
      if (!body.ok) {
        send(res, req, body.tooLarge ? 413 : 400, {
          error: body.tooLarge ? 'request body too large' : 'invalid JSON body',
          reason: 'invalid-request',
        });
        return;
      }
      const result = await submitDaemonRun(registryFile, runsDir, body.value, runDeps);
      if (!result.ok) {
        const status = result.reason === 'invalid-request' ? 400 : result.reason === 'unknown-repo' ? 404 : 409;
        send(res, req, status, { error: result.detail, reason: result.reason });
        return;
      }
      if (result.created) {
        const context = createDaemonLaneContext(result.entry);
        const run = executeDaemonRun(runsDir, result.run, context, runExecutor, runDeps)
          .catch(() => undefined)
          .finally(() => pendingRuns.delete(run));
        pendingRuns.add(run);
        send(res, req, 201, { run: result.run });
        return;
      }
      send(res, req, 200, { run: result.run });
      return;
    }

    if (pathname === '/self-fix') {
      if (req.method !== 'POST') {
        send(res, req, 405, { error: 'method not allowed' }, 'POST');
        return;
      }
      const body = await readJsonBody(req, MAX_REQUEST_BODY_BYTES);
      if (!body.ok) {
        send(res, req, body.tooLarge ? 413 : 400, {
          error: body.tooLarge ? 'request body too large' : 'invalid JSON body',
          reason: 'invalid-request',
        });
        return;
      }
      const result = await submitDaemonSelfFix(registryFile, body.value, {
        ...opts.selfFixDeps,
        client: opts.selfFixDeps?.client ?? opts.selfFixClient,
      });
      if (!result.ok) {
        const status = result.reason === 'invalid-request' ? 400 : result.reason === 'unknown-repo' ? 404 : 503;
        send(res, req, status, { error: result.detail, reason: result.reason });
        return;
      }
      send(res, req, result.result.action === 'created' ? 201 : 200, { selfFix: result.result });
      return;
    }

    const segments = pathname.split('/').filter((s) => s.length > 0);
    if (segments.length === 2 && segments[0] === 'runs') {
      if (req.method !== 'GET') {
        send(res, req, 405, { error: 'method not allowed' }, 'GET');
        return;
      }
      const runId = segments[1] as string;
      const run = isValidRunId(runId) ? await readDaemonRun(daemonRunFile(runsDir, runId)) : null;
      if (run === null) {
        send(res, req, 404, { error: `no run ${runId}`, reason: 'unknown-run' });
        return;
      }
      send(res, req, 200, { run });
      return;
    }
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

    if (segments.length === 4 && segments[0] === 'repos' && segments[3] === 'policy') {
      if (req.method !== 'GET' && req.method !== 'PUT') {
        send(res, req, 405, { error: 'method not allowed' }, 'GET, PUT');
        return;
      }
      const slug = `${segments[1]}/${segments[2]}`;
      const registry = await loadRegistry(registryFile);
      const entry = registry.repos[slug];
      if (!entry || entry.state === 'detached') {
        send(res, req, 404, { error: `repo ${slug} is not attached`, reason: 'not-attached' });
        return;
      }
      const configPath = getFactoryPaths(entry.path, entry.stateRoot).config;

      try {
        if (req.method === 'GET') {
          send(res, req, 200, { repo: slug, ...resolveSafeRepoPolicy(configPath) });
          return;
        }

        const body = await readJsonBody(req, MAX_REQUEST_BODY_BYTES);
        if (!body.ok) {
          send(res, req, body.tooLarge ? 413 : 400, {
            error: body.tooLarge ? 'request body too large' : 'invalid JSON body',
            reason: 'invalid-request',
          });
          return;
        }
        const payload = body.value;
        const field = isPlainObject(payload) ? payload.field : undefined;
        const value = isPlainObject(payload) ? payload.value : undefined;
        const confirmationToken =
          isPlainObject(payload) && typeof payload.confirmationToken === 'string'
            ? payload.confirmationToken
            : undefined;
        if (!isSafePolicyFieldId(field) || typeof value !== 'boolean') {
          send(res, req, 400, {
            error: 'field must be a safe policy field id and value must be a boolean',
            reason: 'invalid-field',
          });
          return;
        }
        const confirmation = policyConfirmationFor(field, value);
        if (confirmation && confirmationToken !== confirmation.token) {
          send(res, req, 400, {
            error: `confirmation required: ${confirmation.auditText}`,
            reason: 'confirmation-required',
          });
          return;
        }
        const snapshot = setSafeRepoPolicyField(configPath, field, value, { confirmationToken });
        if (confirmation) {
          log(`AUDIT ${slug}: ${confirmation.auditText}`);
        }
        send(res, req, 200, { repo: slug, ...snapshot });
        return;
      } catch (err) {
        send(res, req, 500, { error: err instanceof Error ? err.message : String(err) });
        return;
      }
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
      // Like drains, an executor that never settles deliberately holds shutdown.
      await Promise.allSettled([...pendingDrains, ...pendingRuns]);
      await new Promise<void>((resolvePromise) => {
        server.closeAllConnections();
        server.close(() => resolvePromise());
      });
    },
  };

  return factoryd;
}
