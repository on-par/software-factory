import http from 'node:http';
import net from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { isAllowedHost, startEgressProxy, type EgressProxy } from './egress-proxy.js';

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

describe('enforce mode (#2215)', () => {
  async function enforcing(allowHosts: string[]): Promise<{ proxy: EgressProxy; denied: string[]; hosts: string[] }> {
    const denied: string[] = [];
    const hosts: string[] = [];
    const proxy = await startEgressProxy({
      allowHosts,
      enforce: true,
      onDenied: (h) => denied.push(h),
      onHost: (h) => hosts.push(h),
    });
    cleanups.push(() => proxy.close());
    return { proxy, denied, hosts };
  }

  it('forwards a CONNECT to a listed host and never calls onDenied', async () => {
    const upstreamPort = await startUpstream();
    const { proxy, denied } = await enforcing(['localhost']);
    const { status, socket } = await connectTunnel(proxy, `localhost:${upstreamPort}`);
    socket.destroy();
    expect(status).toBe(200);
    expect(denied).toEqual([]);
  });

  it('answers 403 to CONNECT api.nuget.org:443 and calls onDenied once with api.nuget.org across repeated attempts', async () => {
    const { proxy, denied, hosts } = await enforcing(['api.anthropic.com']);
    const req = 'CONNECT api.nuget.org:443 HTTP/1.1\r\nHost: x\r\n\r\n';
    expect(await rawExchange(proxy.port, req)).toContain('403');
    expect(await rawExchange(proxy.port, req)).toContain('403');
    expect(denied).toEqual(['api.nuget.org']);
    expect(hosts).toEqual(['api.nuget.org']);
  });

  it('answers 403 to absolute-form HTTP for an unlisted host', async () => {
    const { proxy, denied } = await enforcing(['github.com']);
    const out = await rawExchange(
      proxy.port,
      'GET http://unlisted.example/ HTTP/1.1\r\nHost: unlisted.example\r\nConnection: close\r\n\r\n',
    );
    expect(out).toContain('403');
    expect(denied).toEqual(['unlisted.example']);
  });

  it('a .nuget.org entry forwards api.nuget.org and refuses nuget.org.example.com with 403', async () => {
    const { proxy, denied } = await enforcing(['.nuget.org']);
    const bad = await rawExchange(proxy.port, 'CONNECT nuget.org.example.com:443 HTTP/1.1\r\nHost: x\r\n\r\n');
    expect(bad).toContain('403');
    expect(denied).toEqual(['nuget.org.example.com']);

    // The upstream is a real host: only the proxy's decision matters, so close after the first bytes.
    const good = await new Promise<string>((resolve) => {
      const sock = net.connect(proxy.port, '127.0.0.1');
      const done = (data: string): void => {
        sock.destroy();
        resolve(data);
      };
      const timer = setTimeout(() => done(''), 1000);
      sock.on('data', (d) => {
        clearTimeout(timer);
        done(d.toString());
      });
      sock.on('close', () => {
        clearTimeout(timer);
        done('');
      });
      sock.on('error', () => undefined);
      sock.write('CONNECT api.nuget.org:443 HTTP/1.1\r\nHost: x\r\n\r\n');
    });
    expect(good).not.toContain('403');
    expect(denied).toEqual(['nuget.org.example.com']);
  });

  it('report mode still forwards an unlisted host without calling onDenied', async () => {
    const upstreamPort = await startUpstream();
    const denied: string[] = [];
    const proxy = await startEgressProxy({ allowHosts: ['github.com'], onDenied: (h) => denied.push(h) });
    cleanups.push(() => proxy.close());
    const { status, socket } = await connectTunnel(proxy, `localhost:${upstreamPort}`);
    socket.destroy();
    expect(status).toBe(200);
    expect(denied).toEqual([]);
  });
});

describe('isAllowedHost leading-dot entries (#2215)', () => {
  it('matches the domain and its subdomains', () => {
    for (const h of ['nuget.org', 'api.nuget.org', 'A.B.NUGET.ORG']) {
      expect(isAllowedHost(h, [' .Nuget.ORG '])).toBe(true);
    }
  });
  it('rejects look-alikes', () => {
    for (const h of ['nuget.org.example.com', 'xnuget.org']) expect(isAllowedHost(h, ['.nuget.org'])).toBe(false);
  });
  it("treats '.' as matching nothing", () => {
    expect(isAllowedHost('nuget.org', ['.'])).toBe(false);
    expect(isAllowedHost('', ['.'])).toBe(false);
  });
});
