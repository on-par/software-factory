// src/proxy/index.ts — Opt-in loopback reverse proxy: stable per-lane URLs
// http://<lane>.<domain>[:port] resolved per-request against the port-lease
// registry (.factory/ports.json), so routes always track the lease lifecycle.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { basename, dirname } from 'node:path';

import { defaultIsPidAlive, type PortLease, readPortLeases } from '../environment/index.js';

const DNS_LABEL_MAX_LENGTH = 63;

/** Derives a DNS-safe host label from a worktree path (worktreeId IS the
 *  worktree path — see environment/index.ts). Lowercased, every run of
 *  characters outside [a-z0-9-] collapsed to a single '-', leading/trailing
 *  '-' trimmed, truncated to the 63-char DNS label limit. */
export function laneHostLabel(worktreeId: string): string {
  const lowered = basename(worktreeId).toLowerCase();
  const collapsed = lowered.replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return collapsed.slice(0, DNS_LABEL_MAX_LENGTH).replace(/-+$/g, '');
}

export function laneHostname(worktreeId: string, domain: string): string {
  return `${laneHostLabel(worktreeId)}.${domain}`;
}

export interface LaneProxySettings {
  domain: string;
  port: number;
}

/** `http://<label>.<domain>` when port is 80 (literally port-free), else with `:<port>`. */
export function laneBaseUrl(worktreeId: string, settings: LaneProxySettings): string {
  const hostname = laneHostname(worktreeId, settings.domain);
  return settings.port === 80 ? `http://${hostname}` : `http://${hostname}:${settings.port}`;
}

// ---------- Proxy singleton state (.factory/proxy.json) ----------

export interface ProxyState {
  version: 1;
  pid: number;
  port: number;
  domain: string;
  startedAt: string;
}

/** Returns undefined on a missing or corrupt state file — never throws. */
export function readProxyState(file: string): ProxyState | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8'));
    if (
      !raw ||
      typeof raw !== 'object' ||
      typeof raw.pid !== 'number' ||
      typeof raw.port !== 'number' ||
      typeof raw.domain !== 'string' ||
      typeof raw.startedAt !== 'string'
    ) {
      return undefined;
    }
    return { version: 1, pid: raw.pid, port: raw.port, domain: raw.domain, startedAt: raw.startedAt };
  } catch {
    return undefined;
  }
}

export function writeProxyState(file: string, state: ProxyState): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
}

/** Idempotent — never throws, even if the file is already gone. */
export function clearProxyState(file: string): void {
  try {
    rmSync(file, { force: true });
  } catch {
    // best-effort cleanup only
  }
}

/** Reads the state and returns it only when the recorded pid is still alive
 *  (per `isPidAlive`, default `defaultIsPidAlive`); undefined otherwise. */
export function isProxyRunning(
  file: string,
  isPidAlive: (pid: number) => boolean = defaultIsPidAlive,
): ProxyState | undefined {
  const state = readProxyState(file);
  if (!state) return undefined;
  return isPidAlive(state.pid) ? state : undefined;
}

// ---------- The proxy itself ----------

export interface LaneProxyOptions {
  /** paths.ports — the port-lease registry file. */
  registryFile: string;
  domain?: string;
  /** Default 80; pass 0 in tests for an ephemeral port. */
  port?: number;
  /** Default '127.0.0.1' — never anything else in production code paths. */
  host?: string;
  /** Injectable for tests; defaults to readPortLeases. */
  readLeases?: (file: string) => PortLease[];
}

export interface LaneProxy {
  server: http.Server;
  /** Actual bound port after start() resolves. */
  port: number;
  start(): Promise<number>;
  stop(): Promise<void>;
}

interface ResolvedHost {
  label: string;
  isHealthCheck: boolean;
}

export function createLaneProxy(opts: LaneProxyOptions): LaneProxy {
  const { registryFile } = opts;
  const domain = (opts.domain ?? 'factory.localhost').toLowerCase();
  const desiredPort = opts.port ?? 80;
  const host = opts.host ?? '127.0.0.1';
  const readLeases = opts.readLeases ?? readPortLeases;

  function resolveHost(hostHeader: string | undefined): ResolvedHost | null {
    if (!hostHeader) return null;
    const hostname = hostHeader.split(':')[0]?.toLowerCase() ?? '';
    if (hostname === domain) return { label: '', isHealthCheck: true };
    const suffix = `.${domain}`;
    if (hostname.endsWith(suffix)) {
      return { label: hostname.slice(0, -suffix.length), isHealthCheck: false };
    }
    return null;
  }

  function findLease(label: string): PortLease | undefined {
    return readLeases(registryFile).find((lease) => laneHostLabel(lease.worktreeId) === label);
  }

  function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const resolved = resolveHost(req.headers.host);
    if (!resolved) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('unknown host');
      return;
    }

    if (resolved.isHealthCheck) {
      const routes = readLeases(registryFile).map((lease) => ({
        label: laneHostLabel(lease.worktreeId),
        port: lease.port,
      }));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, routes }));
      return;
    }

    const lease = findLease(resolved.label);
    if (!lease) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end(`lane "${resolved.label}" is not running`);
      return;
    }

    const upstream = http.request(
      { host: '127.0.0.1', port: lease.port, method: req.method, path: req.url, headers: req.headers },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    upstream.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain' });
      }
      res.end(`lane "${resolved.label}" holds port ${lease.port} but nothing is answering`);
    });
    req.pipe(upstream);
  }

  function handleUpgrade(req: http.IncomingMessage, socket: net.Socket, head: Buffer): void {
    const resolved = resolveHost(req.headers.host);
    const lease = resolved && !resolved.isHealthCheck ? findLease(resolved.label) : undefined;
    if (!lease) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const target = net.connect({ host: '127.0.0.1', port: lease.port }, () => {
      const requestLine = `${req.method} ${req.url} HTTP/1.1\r\n`;
      const headerLines = Object.entries(req.headers)
        .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : (value ?? '')}\r\n`)
        .join('');
      target.write(`${requestLine}${headerLines}\r\n`);
      if (head.length > 0) target.write(head);
      socket.pipe(target);
      target.pipe(socket);
    });

    const destroyBoth = () => {
      socket.destroy();
      target.destroy();
    };
    target.on('error', destroyBoth);
    socket.on('error', destroyBoth);
    target.on('close', destroyBoth);
    socket.on('close', destroyBoth);
  }

  const server = http.createServer(handleRequest);
  server.on('upgrade', handleUpgrade);

  const proxy: LaneProxy = {
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
          proxy.port = addr && typeof addr === 'object' ? addr.port : desiredPort;
          resolvePromise(proxy.port);
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen({ port: desiredPort, host, exclusive: true });
      });
    },
    stop(): Promise<void> {
      return new Promise((resolvePromise) => {
        server.close(() => resolvePromise());
      });
    },
  };

  return proxy;
}
