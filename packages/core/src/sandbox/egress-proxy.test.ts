import http from 'node:http';
import net from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import {
  egressSummaryMessage,
  isAllowedHost,
  isSafeHttpHeaderName,
  sanitizeProxyHeaders,
  startEgressProxy,
  type EgressProxy,
} from './egress-proxy.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

async function startUpstream(): Promise<number> {
  const server = http.createServer((_req, res) => res.end('ok'));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });
  return (server.address() as net.AddressInfo).port;
}

async function proxyWith(allowHosts: string[], calls: Array<[string, boolean]> = []): Promise<EgressProxy> {
  const proxy = await startEgressProxy({ allowHosts, onHost: (h, a) => calls.push([h, a]) });
  cleanups.push(() => proxy.close());
  return proxy;
}

/** Sends raw bytes to the proxy and resolves with everything it sends back until close. */
function rawExchange(port: number, payload: string): Promise<string> {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1');
    let data = '';
    sock.on('data', (d) => (data += d.toString()));
    sock.on('close', () => resolve(data));
    sock.on('error', () => resolve(data));
    sock.write(payload);
  });
}

function connectTunnel(proxy: EgressProxy, target: string): Promise<{ status: number; socket: net.Socket }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: proxy.port, method: 'CONNECT', path: target });
    req.on('connect', (res, socket) => resolve({ status: res.statusCode ?? 0, socket }));
    req.on('error', reject);
    req.end();
  });
}

describe('startEgressProxy', () => {
  it('forwards a CONNECT tunnel and records an unlisted host', async () => {
    const upstreamPort = await startUpstream();
    const calls: Array<[string, boolean]> = [];
    const proxy = await proxyWith(['api.anthropic.com', 'github.com'], calls);

    const { status, socket } = await connectTunnel(proxy, `localhost:${upstreamPort}`);
    expect(status).toBe(200);
    const body = await new Promise<string>((resolve) => {
      let data = '';
      socket.on('data', (d) => (data += d.toString()));
      socket.on('close', () => resolve(data));
      socket.write('GET /v3/index.json HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
    });
    expect(body).toContain('200 OK');
    expect(body.endsWith('ok')).toBe(true);
    expect(calls).toEqual([['localhost', false]]);
  });

  it('forwards absolute-form plain HTTP and records the host', async () => {
    const upstreamPort = await startUpstream();
    const calls: Array<[string, boolean]> = [];
    const proxy = await proxyWith([], calls);

    const body = await new Promise<string>((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port: proxy.port, path: `http://localhost:${upstreamPort}/x?y=1` }, (res) => {
          let data = '';
          res.on('data', (d) => (data += d.toString()));
          res.on('end', () => resolve(data));
        })
        .on('error', reject);
    });
    expect(body).toBe('ok');
    expect(calls).toEqual([['localhost', false]]);
  });

  it('answers 400 to a non-absolute-form request and records nothing', async () => {
    const calls: Array<[string, boolean]> = [];
    const proxy = await proxyWith([], calls);
    const out = await rawExchange(proxy.port, 'GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
    expect(out).toContain('400');
    expect(calls).toEqual([]);
  });

  it('fires onHost once per distinct host regardless of casing', async () => {
    const upstreamPort = await startUpstream();
    const calls: Array<[string, boolean]> = [];
    const proxy = await proxyWith([], calls);
    for (let i = 0; i < 50; i++) {
      const { socket } = await connectTunnel(proxy, `${i % 2 ? 'LocalHost' : 'localhost'}:${upstreamPort}`);
      socket.destroy();
    }
    expect(calls).toHaveLength(1);
    expect(proxy.hosts()).toEqual(['localhost']);
  });

  it('marks a listed host as allowed', async () => {
    const upstreamPort = await startUpstream();
    const calls: Array<[string, boolean]> = [];
    const proxy = await proxyWith(['LOCALHOST'], calls);
    const { socket } = await connectTunnel(proxy, `localhost:${upstreamPort}`);
    socket.destroy();
    expect(calls).toEqual([['localhost', true]]);
  });

  it('answers 502 when the upstream refuses and still records the host', async () => {
    const closed = await new Promise<number>((resolve) => {
      const s = net.createServer().listen(0, '127.0.0.1', () => {
        const p = (s.address() as net.AddressInfo).port;
        s.close(() => resolve(p));
      });
    });
    const calls: Array<[string, boolean]> = [];
    const proxy = await proxyWith([], calls);
    const out = await rawExchange(proxy.port, `CONNECT localhost:${closed} HTTP/1.1\r\nHost: localhost\r\n\r\n`);
    expect(out).toContain('502');
    expect(calls).toEqual([['localhost', false]]);
  });

  it('answers 400 to a malformed CONNECT target without recording', async () => {
    const calls: Array<[string, boolean]> = [];
    const proxy = await proxyWith([], calls);
    for (const target of ['noport', 'host:0', 'host:99999', 'host:abc']) {
      const out = await rawExchange(proxy.port, `CONNECT ${target} HTTP/1.1\r\nHost: x\r\n\r\n`);
      expect(out, target).toContain('400');
    }
    expect(calls).toEqual([]);
  });

  it('strips brackets from an IPv6 literal target', async () => {
    const calls: Array<[string, boolean]> = [];
    const proxy = await proxyWith([], calls);
    await rawExchange(proxy.port, 'CONNECT [::1]:1 HTTP/1.1\r\nHost: x\r\n\r\n');
    expect(calls[0]?.[0]).toBe('::1');
  });

  it('does not let a throwing onHost break traffic', async () => {
    const upstreamPort = await startUpstream();
    const proxy = await startEgressProxy({
      allowHosts: [],
      onHost: () => {
        throw new Error('log failed');
      },
    });
    cleanups.push(() => proxy.close());
    const { status, socket } = await connectTunnel(proxy, `localhost:${upstreamPort}`);
    socket.destroy();
    expect(status).toBe(200);
  });

  it('releases the port on close, even with a tunnel attached, and close is idempotent', async () => {
    const upstreamPort = await startUpstream();
    const proxy = await proxyWith([]);
    const { socket } = await connectTunnel(proxy, `localhost:${upstreamPort}`);
    socket.on('error', () => {});
    await proxy.close();
    await proxy.close();
    const code = await new Promise<string>((resolve) => {
      const s = net.connect(proxy.port, '127.0.0.1');
      s.on('connect', () => {
        s.destroy();
        resolve('connected');
      });
      s.on('error', (e: NodeJS.ErrnoException) => resolve(e.code ?? 'error'));
    });
    expect(code).toBe('ECONNREFUSED');
  });
});

describe('isAllowedHost', () => {
  it('matches exactly and case-insensitively, without suffix matching', () => {
    expect(isAllowedHost('API.Anthropic.com', ['api.anthropic.com'])).toBe(true);
    expect(isAllowedHost(' github.com ', ['github.com'])).toBe(true);
    expect(isAllowedHost('foo.github.com', ['github.com'])).toBe(false);
    expect(isAllowedHost('x', [])).toBe(false);
  });
});

describe('egressSummaryMessage', () => {
  it('lists unlisted hosts sorted', () => {
    expect(egressSummaryMessage(['b.com', 'github.com', 'a.com'], ['github.com'])).toBe(
      '3 host(s) used, 2 not on allowlist: a.com, b.com',
    );
  });
  it('says all on allowlist when every host is listed, and handles zero hosts', () => {
    expect(egressSummaryMessage(['github.com'], ['github.com'])).toBe('1 host(s) used, all on allowlist');
    expect(egressSummaryMessage([], ['github.com'])).toBe('0 host(s) used, all on allowlist');
  });
});

describe('sanitizeProxyHeaders', () => {
  it('forwards only allowlisted names and drops hop-by-hop / unsafe keys', () => {
    const incoming = Object.create(null) as http.IncomingHttpHeaders;
    incoming['content-type'] = 'application/json';
    incoming['x-custom-evil'] = 'nope';
    incoming.connection = 'keep-alive';
    incoming['transfer-encoding'] = 'chunked';
    incoming.authorization = 'Bearer t';
    const out = sanitizeProxyHeaders(incoming);
    expect(out['content-type']).toBe('application/json');
    expect(out.authorization).toBe('Bearer t');
    expect(Object.prototype.hasOwnProperty.call(out, 'x-custom-evil')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(out, 'connection')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(out, 'transfer-encoding')).toBe(false);
    expect(Object.getPrototypeOf(out)).toBeNull();
  });

  it('applies overrides for allowlisted names (e.g. Host from the URL)', () => {
    const out = sanitizeProxyHeaders({ host: '127.0.0.1:9', accept: '*/*' }, { host: 'api.example:443' });
    expect(out.host).toBe('api.example:443');
    expect(out.accept).toBe('*/*');
  });

  it('preserves content-type through an absolute-form plain HTTP round trip', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'x-upstream-only': '1' });
      res.end('{"ok":true}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    cleanups.push(async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    });
    const upstreamPort = (server.address() as net.AddressInfo).port;
    const proxy = await proxyWith([]);
    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port: proxy.port, path: `http://localhost:${upstreamPort}/` }, resolve)
        .on('error', reject);
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/json');
    expect(res.headers['x-upstream-only']).toBeUndefined();
    res.resume();
  });
});

describe('isSafeHttpHeaderName', () => {
  it('accepts RFC 7230 tokens and rejects separators / prototype keys', () => {
    expect(isSafeHttpHeaderName('Content-Type')).toBe(true);
    expect(isSafeHttpHeaderName('x-request-id')).toBe(true);
    expect(isSafeHttpHeaderName('bad name')).toBe(false);
    expect(isSafeHttpHeaderName('bad:name')).toBe(false);
    expect(isSafeHttpHeaderName('__proto__')).toBe(false);
    expect(isSafeHttpHeaderName('constructor')).toBe(false);
  });
});
