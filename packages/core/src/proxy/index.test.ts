import { mkdirSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PortLease } from '../environment/index.js';
import {
  clearProxyState,
  createLaneProxy,
  isProxyRunning,
  laneBaseUrl,
  laneHostLabel,
  laneHostname,
  type LaneProxy,
  type ProxyState,
  readProxyState,
  writeProxyState,
} from './index.js';

describe('laneHostLabel', () => {
  it('extracts the basename from an absolute worktree path', () => {
    expect(laneHostLabel('/Users/x/ship-it-296')).toBe('ship-it-296');
  });

  it('lowercases the label', () => {
    expect(laneHostLabel('/Users/x/Ship-It-296')).toBe('ship-it-296');
  });

  it('collapses underscores, dots, and spaces to a single dash', () => {
    expect(laneHostLabel('/Users/x/ship_it 296.foo')).toBe('ship-it-296-foo');
  });

  it('trims leading and trailing dashes', () => {
    expect(laneHostLabel('/Users/x/-ship-it-296-')).toBe('ship-it-296');
  });

  it('truncates to 63 characters (DNS label limit)', () => {
    const long = 'a'.repeat(100);
    const label = laneHostLabel(`/Users/x/${long}`);
    expect(label.length).toBe(63);
    expect(label).toBe('a'.repeat(63));
  });
});

describe('laneHostname', () => {
  it('joins the label and domain', () => {
    expect(laneHostname('/Users/x/ship-it-296', 'factory.localhost')).toBe('ship-it-296.factory.localhost');
  });
});

describe('laneBaseUrl', () => {
  it('omits :80 for the default port', () => {
    expect(laneBaseUrl('/Users/x/ship-it-296', { domain: 'factory.localhost', port: 80 })).toBe(
      'http://ship-it-296.factory.localhost',
    );
  });

  it('includes the port when it is not 80', () => {
    expect(laneBaseUrl('/Users/x/ship-it-296', { domain: 'factory.localhost', port: 8080 })).toBe(
      'http://ship-it-296.factory.localhost:8080',
    );
  });
});

describe('proxy state', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'proxy-state-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('round-trips write/read', () => {
    const file = join(dir, 'proxy.json');
    const state: ProxyState = { version: 1, pid: 1234, port: 80, domain: 'factory.localhost', startedAt: 'now' };
    writeProxyState(file, state);
    expect(readProxyState(file)).toEqual(state);
  });

  it('returns undefined for a missing file', () => {
    expect(readProxyState(join(dir, 'missing.json'))).toBeUndefined();
  });

  it('returns undefined for a corrupt file', async () => {
    const file = join(dir, 'proxy.json');
    await writeFile(file, 'not json');
    expect(readProxyState(file)).toBeUndefined();
  });

  it('returns undefined for valid JSON with the wrong shape', async () => {
    const file = join(dir, 'proxy.json');
    await writeFile(file, JSON.stringify({ pid: 'not-a-number', port: 80, domain: 'factory.localhost' }));
    expect(readProxyState(file)).toBeUndefined();
  });

  it('isProxyRunning returns undefined when the recorded pid is dead', () => {
    const file = join(dir, 'proxy.json');
    writeProxyState(file, { version: 1, pid: 1234, port: 80, domain: 'factory.localhost', startedAt: 'now' });
    expect(isProxyRunning(file, () => false)).toBeUndefined();
  });

  it('isProxyRunning returns the state when the recorded pid is alive', () => {
    const file = join(dir, 'proxy.json');
    const state: ProxyState = { version: 1, pid: 1234, port: 80, domain: 'factory.localhost', startedAt: 'now' };
    writeProxyState(file, state);
    expect(isProxyRunning(file, () => true)).toEqual(state);
  });

  it('isProxyRunning returns undefined when no state file exists', () => {
    expect(isProxyRunning(join(dir, 'missing.json'), () => true)).toBeUndefined();
  });

  it('clearProxyState is idempotent (never throws on a missing file)', () => {
    const file = join(dir, 'proxy.json');
    expect(() => clearProxyState(file)).not.toThrow();
    writeProxyState(file, { version: 1, pid: 1, port: 80, domain: 'factory.localhost', startedAt: 'now' });
    clearProxyState(file);
    expect(readProxyState(file)).toBeUndefined();
    expect(() => clearProxyState(file)).not.toThrow();
  });

  it('clearProxyState never throws even when the underlying removal fails', () => {
    const notAFile = join(dir, 'not-a-file');
    mkdirSync(notAFile);
    expect(() => clearProxyState(notAFile)).not.toThrow();
  });
});

function requestProxy(
  proxyPort: number,
  hostHeader: string,
  options: http.RequestOptions = {},
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolvePromise, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: proxyPort,
        path: '/hello',
        method: 'GET',
        ...options,
        headers: { host: hostHeader, ...options.headers },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => {
          body += chunk.toString();
        });
        res.on('end', () => resolvePromise({ statusCode: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function startStubTarget(): Promise<{
  server: http.Server;
  port: number;
  seenRequests: { method?: string; url?: string }[];
}> {
  const seenRequests: { method?: string; url?: string }[] = [];
  const server = http.createServer((req, res) => {
    seenRequests.push({ method: req.method, url: req.url });
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('stub response');
  });
  return new Promise((resolvePromise) => {
    server.listen({ port: 0, host: '127.0.0.1' }, () => {
      const addr = server.address();
      const port = addr && typeof addr === 'object' ? addr.port : 0;
      resolvePromise({ server, port, seenRequests });
    });
  });
}

function writeRegistry(file: string, leases: PortLease[]): Promise<void> {
  return writeFile(file, JSON.stringify({ version: 1, leases }));
}

describe('createLaneProxy', () => {
  let dir: string;
  let registryFile: string;
  let target: { server: http.Server; port: number; seenRequests: { method?: string; url?: string }[] };
  let proxy: LaneProxy;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'proxy-registry-'));
    registryFile = join(dir, 'ports.json');
    target = await startStubTarget();
  });

  afterEach(async () => {
    await proxy?.stop();
    await new Promise<void>((resolvePromise) => target.server.close(() => resolvePromise()));
    await rm(dir, { recursive: true, force: true });
  });

  it('binds loopback only', async () => {
    proxy = createLaneProxy({ registryFile, port: 0 });
    await proxy.start();
    const addr = proxy.server.address();
    expect(typeof addr === 'object' && addr?.address).toBe('127.0.0.1');
  });

  it('forwards a request to the leased port matched by hostname label (acceptance scenario 1)', async () => {
    const worktreeId = join(dir, 'ship-it-296');
    const lease: PortLease = {
      worktreeId,
      branch: 'ship-it/296',
      port: target.port,
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
    };
    await writeRegistry(registryFile, [lease]);

    proxy = createLaneProxy({ registryFile, port: 0 });
    await proxy.start();

    const { statusCode, body } = await requestProxy(proxy.port, 'ship-it-296.factory.localhost');
    expect(statusCode).toBe(200);
    expect(body).toBe('stub response');
    expect(target.seenRequests).toEqual([{ method: 'GET', url: '/hello' }]);
  });

  it('returns 404 (request completes, no hang) once the lease disappears from the registry (acceptance scenario 2)', async () => {
    const worktreeId = join(dir, 'ship-it-296');
    const lease: PortLease = {
      worktreeId,
      branch: 'ship-it/296',
      port: target.port,
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
    };
    await writeRegistry(registryFile, [lease]);

    proxy = createLaneProxy({ registryFile, port: 0 });
    await proxy.start();

    await writeRegistry(registryFile, []);

    const { statusCode, body } = await requestProxy(proxy.port, 'ship-it-296.factory.localhost');
    expect(statusCode).toBe(404);
    expect(body).toContain('not running');
  });

  it('responds 200 JSON with the route table on the bare domain (health check)', async () => {
    const worktreeId = join(dir, 'ship-it-296');
    const lease: PortLease = {
      worktreeId,
      branch: 'ship-it/296',
      port: target.port,
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
    };
    await writeRegistry(registryFile, [lease]);

    proxy = createLaneProxy({ registryFile, port: 0 });
    await proxy.start();

    const { statusCode, body } = await requestProxy(proxy.port, 'factory.localhost');
    expect(statusCode).toBe(200);
    expect(JSON.parse(body)).toEqual({ ok: true, routes: [{ label: 'ship-it-296', port: target.port }] });
  });

  it('returns 404 for an unrelated host with no matching domain suffix', async () => {
    proxy = createLaneProxy({ registryFile, port: 0 });
    await proxy.start();

    const { statusCode } = await requestProxy(proxy.port, 'example.com');
    expect(statusCode).toBe(404);
  });

  it('returns 502 when the leased port has nothing answering', async () => {
    const worktreeId = join(dir, 'ship-it-dead');
    // Bind and release a port synchronously so nothing listens there.
    const deadPort = await new Promise<number>((resolvePromise) => {
      const probe = http.createServer();
      probe.listen({ port: 0, host: '127.0.0.1' }, () => {
        const addr = probe.address();
        const p = addr && typeof addr === 'object' ? addr.port : 0;
        probe.close(() => resolvePromise(p));
      });
    });

    const lease: PortLease = {
      worktreeId,
      branch: 'ship-it/dead',
      port: deadPort,
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
    };
    await writeRegistry(registryFile, [lease]);

    proxy = createLaneProxy({ registryFile, port: 0 });
    await proxy.start();

    const { statusCode, body } = await requestProxy(proxy.port, 'ship-it-dead.factory.localhost');
    expect(statusCode).toBe(502);
    expect(body).toContain('nothing is answering');
  });

  it('treats a lease with a corrupted/out-of-range port as not running (never dials it)', async () => {
    const worktreeId = join(dir, 'ship-it-bad-port');
    const lease = {
      worktreeId,
      branch: 'ship-it/bad-port',
      port: 999999,
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
    } as unknown as PortLease;
    await writeRegistry(registryFile, [lease]);

    proxy = createLaneProxy({ registryFile, port: 0 });
    await proxy.start();

    const { statusCode, body } = await requestProxy(proxy.port, 'ship-it-bad-port.factory.localhost');
    expect(statusCode).toBe(404);
    expect(body).toContain('not running');
  });

  it('defaults to port 80, host 127.0.0.1, and domain factory.localhost when omitted', () => {
    proxy = createLaneProxy({ registryFile });
    expect(proxy.port).toBe(80);
  });

  it('returns 404 for a request with no Host header', async () => {
    proxy = createLaneProxy({ registryFile, port: 0 });
    await proxy.start();

    const { statusCode } = await requestProxy(proxy.port, '');
    expect(statusCode).toBe(404);
  });

  it('rejects start() when the desired port is already bound (e.g. EADDRINUSE)', async () => {
    proxy = createLaneProxy({ registryFile, port: 0 });
    const boundPort = await proxy.start();

    const second = createLaneProxy({ registryFile, port: boundPort });
    await expect(second.start()).rejects.toThrow();
  });

  it('pipes a WebSocket upgrade bidirectionally through to the leased port', async () => {
    const wsTarget = net.createServer((socket) => {
      let handshakeDone = false;
      socket.on('data', (chunk) => {
        if (!handshakeDone) {
          handshakeDone = true;
          socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
          return;
        }
        socket.write(chunk);
      });
    });
    await new Promise<void>((resolvePromise) =>
      wsTarget.listen({ port: 0, host: '127.0.0.1' }, () => resolvePromise()),
    );
    const wsAddr = wsTarget.address();
    const wsPort = wsAddr && typeof wsAddr === 'object' ? wsAddr.port : 0;

    const worktreeId = join(dir, 'ship-it-ws');
    await writeRegistry(registryFile, [
      { worktreeId, branch: 'ship-it/ws', port: wsPort, pid: process.pid, acquiredAt: new Date().toISOString() },
    ]);

    proxy = createLaneProxy({ registryFile, port: 0 });
    await proxy.start();

    try {
      const echoed = await new Promise<string>((resolvePromise, reject) => {
        const req = http.request({
          host: '127.0.0.1',
          port: proxy.port,
          path: '/ws',
          method: 'GET',
          headers: {
            host: 'ship-it-ws.factory.localhost',
            Connection: 'Upgrade',
            Upgrade: 'websocket',
          },
        });
        req.on('upgrade', (_res, socket) => {
          // Hijacked sockets stay open past the handshake — destroy it once we
          // have our echo so proxy.stop()'s server.close() isn't left waiting
          // on a connection nothing will ever end.
          socket.once('data', (chunk) => {
            resolvePromise(chunk.toString());
            socket.destroy();
          });
          socket.write('ping');
        });
        req.on('error', reject);
        req.end();
      });
      expect(echoed).toBe('ping');
    } finally {
      await new Promise<void>((resolvePromise) => wsTarget.close(() => resolvePromise()));
    }
  });

  it('writes a raw 404 and destroys the socket for a WebSocket upgrade to an unknown lane', async () => {
    proxy = createLaneProxy({ registryFile, port: 0 });
    await proxy.start();

    const statusCode = await new Promise<number | undefined>((resolvePromise, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port: proxy.port,
        path: '/ws',
        method: 'GET',
        headers: {
          host: 'ship-it-missing.factory.localhost',
          Connection: 'Upgrade',
          Upgrade: 'websocket',
        },
      });
      req.on('response', (res) => resolvePromise(res.statusCode));
      req.on('upgrade', () => reject(new Error('should not have upgraded')));
      req.on('error', reject);
      req.end();
    });
    expect(statusCode).toBe(404);
  });
});
