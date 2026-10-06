// src/sandbox/egress-proxy.ts — report-only HTTP CONNECT proxy for sandboxed agent egress (#2214).
//
// Forwards everything and records each distinct host. It never blocks: the evidence it gathers
// feeds a later slice that enforces `sandbox.network.allow`.

import http from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';

export interface EgressProxyOptions {
  allowHosts: readonly string[];
  /** Fired exactly once per distinct (lowercased) host, before the upstream connect. */
  onHost?: (host: string, allowed: boolean) => void;
  /** Bind address; default '127.0.0.1'. Port is always 0 (ephemeral). */
  bindHost?: string;
}

export interface EgressProxy {
  readonly port: number;
  readonly url: string;
  /** Distinct hosts in first-seen order. */
  hosts(): string[];
  /** Idempotent. */
  close(): Promise<void>;
}

// Exact match only; wildcard/suffix matching is an enforce-slice decision.
export function isAllowedHost(host: string, allowHosts: readonly string[]): boolean {
  const h = host.trim().toLowerCase();
  return allowHosts.some((a) => a.trim().toLowerCase() === h);
}

export function egressSummaryMessage(hosts: readonly string[], allowHosts: readonly string[]): string {
  const unlisted = hosts.filter((h) => !isAllowedHost(h, allowHosts)).sort();
  if (unlisted.length === 0) return `${hosts.length} host(s) used, all on allowlist`;
  return `${hosts.length} host(s) used, ${unlisted.length} not on allowlist: ${unlisted.join(', ')}`;
}

function parseAuthority(target: string): { host: string; port: number } | undefined {
  const m = /^(?:\[([^\]]+)\]|([^:[\]]+)):(\d{1,5})$/.exec(target);
  if (!m) return undefined;
  const host = m[1] ?? m[2];
  const port = Number(m[3]);
  if (!host || port < 1 || port > 65535) return undefined;
  return { host, port };
}

function rejectSocket(socket: Duplex, status: string): void {
  socket.end(`HTTP/1.1 ${status}\r\n\r\n`);
  socket.destroy();
}

export function startEgressProxy(opts: EgressProxyOptions): Promise<EgressProxy> {
  const bindHost = opts.bindHost ?? '127.0.0.1';
  const seen = new Set<string>();
  const sockets = new Set<Duplex>();
  const server = http.createServer();

  const track = (s: Duplex): void => {
    sockets.add(s);
    s.once('close', () => sockets.delete(s));
  };

  const record = (rawHost: string): string => {
    const host = rawHost.toLowerCase().replace(/^\[|\]$/g, '');
    if (!seen.has(host)) {
      seen.add(host);
      try {
        opts.onHost?.(host, isAllowedHost(host, opts.allowHosts));
      } catch {
        // a logging failure must never break traffic
      }
    }
    return host;
  };

  server.on('connection', track);
  server.on('clientError', (_e, s) => s.destroy());

  server.on('connect', (req, clientSocket, head) => {
    clientSocket.on('error', () => clientSocket.destroy());
    const target = parseAuthority(req.url ?? '');
    if (!target) {
      rejectSocket(clientSocket, '400 Bad Request');
      return;
    }
    const host = record(target.host);
    const upstream = net.connect(target.port, host);
    track(upstream);
    let connected = false;
    upstream.on('error', () => {
      if (!connected && !clientSocket.destroyed) clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      clientSocket.destroy();
      upstream.destroy();
    });
    clientSocket.on('error', () => upstream.destroy());
    clientSocket.on('close', () => upstream.destroy());
    upstream.on('close', () => clientSocket.destroy());
    upstream.on('connect', () => {
      connected = true;
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
  });

  server.on('request', (req, res) => {
    let url: URL | undefined;
    try {
      url = new URL(req.url ?? '');
    } catch {
      url = undefined;
    }
    if (!url || url.protocol !== 'http:') {
      res.writeHead(400);
      res.end();
      return;
    }
    const host = record(url.hostname);
    const upstream = http.request({
      host,
      port: url.port ? Number(url.port) : 80,
      method: req.method,
      path: `${url.pathname}${url.search}`,
      headers: req.headers,
    });
    upstream.on('socket', track);
    upstream.on('response', (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
      up.on('error', () => res.destroy());
    });
    upstream.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(502);
        res.end();
      } else {
        res.destroy();
      }
    });
    req.on('error', () => upstream.destroy());
    req.pipe(upstream);
  });

  return new Promise<EgressProxy>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, bindHost, () => {
      server.off('error', reject);
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('egress proxy: no listening address'));
        return;
      }
      const port = addr.port;
      let closing: Promise<void> | undefined;
      resolvePromise({
        port,
        url: `http://${bindHost}:${port}`,
        hosts: () => [...seen],
        close: () => {
          closing ??= new Promise<void>((done) => {
            server.close(() => done());
            server.closeAllConnections();
            for (const s of sockets) s.destroy();
          });
          return closing;
        },
      });
    });
  });
}
