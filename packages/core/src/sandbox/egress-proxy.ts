// src/sandbox/egress-proxy.ts — HTTP CONNECT proxy for sandboxed agent egress (#2214).
//
// Report-only by default: forwards everything (except telemetry hosts when `blockTelemetry` is set, #2667)
// and records each distinct host. With `enforce` (#2215) hosts not on `sandbox.network.allow` get 403. The allowlist gains the registry hosts
// of each detected ecosystem (#2659, #2661 for .NET). Known telemetry hosts are classified
// separately in the egress logs (#2664).

import { statSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { detectDotnetProject } from '../environment/dotnet.js';

export interface EgressProxyOptions {
  allowHosts: readonly string[];
  /** Refuse hosts matching isTelemetryHost with 403 (still recorded) (#2667). */
  blockTelemetry?: boolean;
  /** Fired exactly once per distinct (lowercased) host, before the upstream connect. */
  onHost?: (host: string, allowed: boolean) => void;
  /** Refuse hosts not on allowHosts with 403 (#2215). */
  enforce?: boolean;
  /** Fired once per distinct host refused for not being on allowHosts. */
  onDenied?: (host: string) => void;
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

// Exact match, plus `*.suffix` entries that match any subdomain of suffix but never suffix itself (#2661),
// plus `.suffix` entries that match suffix itself and any subdomain (#2215).
export function isAllowedHost(host: string, allowHosts: readonly string[]): boolean {
  const h = host.trim().toLowerCase();
  return allowHosts.some((raw) => {
    const a = raw.trim().toLowerCase();
    if (a === h) return true;
    if (a.startsWith('.') && a.length > 1 && (h === a.slice(1) || h.endsWith(a))) return true;
    return a.startsWith('*.') && a.length > 2 && h.endsWith(a.slice(1)) && h.length > a.length - 1;
  });
}

/** Known vendor telemetry hosts, same exact / `*.suffix` syntax as the allowlist (#2664). */
export const TELEMETRY_HOST_PATTERNS: readonly string[] = [
  'datadoghq.com',
  '*.datadoghq.com',
  'datadoghq.eu',
  '*.datadoghq.eu',
];

export function isTelemetryHost(host: string): boolean {
  return isAllowedHost(host, TELEMETRY_HOST_PATTERNS);
}

export function egressHostMessage(host: string, allowed: boolean): string {
  const list = allowed ? 'on allowlist' : 'not on allowlist';
  return `${host} (${isTelemetryHost(host) ? `telemetry, ${list}` : list})`;
}

export function egressSummaryMessage(hosts: readonly string[], allowHosts: readonly string[]): string {
  const notListed = hosts.filter((h) => !isAllowedHost(h, allowHosts));
  if (notListed.length === 0) return `${hosts.length} host(s) used, all on allowlist`;
  const telemetry = notListed.filter(isTelemetryHost).sort();
  const unlisted = notListed.filter((h) => !isTelemetryHost(h)).sort();
  const parts: string[] = [];
  if (unlisted.length > 0) parts.push(`${unlisted.length} not on allowlist: ${unlisted.join(', ')}`);
  if (telemetry.length > 0) parts.push(`${telemetry.length} telemetry not on allowlist: ${telemetry.join(', ')}`);
  return `${hosts.length} host(s) used, ${parts.join('; ')}`;
}

/** Package ecosystems a repo can be detected as (#2659, #2661). */
export type Ecosystem = 'node' | 'dotnet';

/** Hosts pre-allowed for a detected ecosystem. Only the ecosystems a repo actually uses are added. */
export const ECOSYSTEM_ALLOW_HOSTS: Readonly<Record<Ecosystem, readonly string[]>> = {
  node: ['registry.npmjs.org', 'registry.yarnpkg.com'],
  dotnet: ['api.nuget.org', '*.nuget.org'],
};

/** A root package.json file is Node; .NET is decided by detectDotnetProject (root or up to 3 levels deep, #3472).
 *  A missing dir or unreadable path detects nothing. */
export function detectEcosystems(repoDir: string): Ecosystem[] {
  if (repoDir === '') return [];
  const found: Ecosystem[] = [];
  try {
    if (statSync(join(repoDir, 'package.json')).isFile()) found.push('node');
  } catch {
    // no package.json
  }
  if (detectDotnetProject(repoDir)) found.push('dotnet');
  return found;
}

/** The configured allowlist plus the hosts of every detected ecosystem, deduped case-insensitively.
 *  An empty configured list means deny-all and is returned unchanged. */
export function buildEgressAllowlist(configured: readonly string[], repoDir: string): string[] {
  const out = [...configured];
  if (out.length === 0) return out;
  for (const eco of detectEcosystems(repoDir)) {
    for (const host of ECOSYSTEM_ALLOW_HOSTS[eco]) {
      if (!isAllowedHost(host, out)) out.push(host);
    }
  }
  return out;
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

/** RFC 7230 §3.2.6 tchar+ — legal HTTP header-name charset. */
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
  'proxy-connection',
]);

/**
 * Forwardable header names as literal constants. Looking up / writing only these
 * keys means remote header maps never become arbitrary property / header-name
 * writes (CodeQL js/remote-property-injection). CONNECT tunnels never hit this
 * path; plain HTTP absolute-form is the only consumer.
 */
const FORWARDABLE_HEADERS = [
  'accept',
  'accept-encoding',
  'accept-language',
  'age',
  'authorization',
  'cache-control',
  'content-disposition',
  'content-encoding',
  'content-language',
  'content-length',
  'content-location',
  'content-range',
  'content-type',
  'cookie',
  'date',
  'etag',
  'expect',
  'expires',
  'forwarded',
  'from',
  'host',
  'if-match',
  'if-modified-since',
  'if-none-match',
  'if-range',
  'if-unmodified-since',
  'last-modified',
  'link',
  'location',
  'max-forwards',
  'origin',
  'pragma',
  'range',
  'referer',
  'retry-after',
  'server',
  'set-cookie',
  'user-agent',
  'vary',
  'via',
  'warning',
  'www-authenticate',
  'x-request-id',
  'x-correlation-id',
] as const;

export function isSafeHttpHeaderName(name: string): boolean {
  if (!HEADER_NAME_RE.test(name)) return false;
  const lower = name.toLowerCase();
  return lower !== '__proto__' && lower !== 'constructor' && lower !== 'prototype';
}

/**
 * Rebuild a headers object using only allowlisted constant names.
 * Drops hop-by-hop headers and anything outside the allowlist.
 */
export function sanitizeProxyHeaders(
  headers: http.IncomingHttpHeaders,
  overrides?: Readonly<Record<string, string>>,
): http.OutgoingHttpHeaders {
  // Fresh null-prototype map; keys are only literals from FORWARDABLE_HEADERS.
  const out: Record<string, string | string[] | number> = Object.create(null);
  for (const name of FORWARDABLE_HEADERS) {
    if (HOP_BY_HOP.has(name)) continue;
    const value = headers[name];
    if (value !== undefined) out[name] = value;
  }
  if (overrides) {
    for (const name of FORWARDABLE_HEADERS) {
      const value = overrides[name];
      if (value !== undefined) out[name] = value;
    }
  }
  return out;
}

/** Write allowlisted headers onto a ServerResponse using literal header names only. */
function applySanitizedHeaders(res: http.ServerResponse, headers: http.IncomingHttpHeaders): void {
  for (const name of FORWARDABLE_HEADERS) {
    if (HOP_BY_HOP.has(name)) continue;
    const value = headers[name];
    if (value === undefined) continue;
    res.setHeader(name, value);
  }
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

  const blocked = (host: string): boolean => opts.blockTelemetry === true && isTelemetryHost(host);

  const deniedSeen = new Set<string>();
  const denied = (host: string): boolean => opts.enforce === true && !isAllowedHost(host, opts.allowHosts);
  const noteDenied = (host: string): void => {
    if (deniedSeen.has(host)) return;
    deniedSeen.add(host);
    try {
      opts.onDenied?.(host);
    } catch {
      // a logging failure must never break traffic
    }
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
    if (blocked(host)) {
      rejectSocket(clientSocket, '403 Forbidden');
      return;
    }
    if (denied(host)) {
      noteDenied(host);
      rejectSocket(clientSocket, '403 Forbidden');
      return;
    }
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
    if (blocked(host)) {
      res.writeHead(403);
      res.end();
      return;
    }
    if (denied(host)) {
      noteDenied(host);
      res.writeHead(403);
      res.end();
      return;
    }
    const upstream = http.request({
      host,
      port: url.port ? Number(url.port) : 80,
      method: req.method,
      path: `${url.pathname}${url.search}`,
      headers: sanitizeProxyHeaders(req.headers, { host: url.host }),
    });
    upstream.on('socket', track);
    upstream.on('response', (up) => {
      // Copy allowlisted headers with literal names only — never pass a remote
      // headers object to writeHead (CodeQL js/remote-property-injection).
      res.statusCode = up.statusCode ?? 502;
      applySanitizedHeaders(res, up.headers);
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
