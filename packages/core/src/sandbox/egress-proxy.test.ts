import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildEgressAllowlist,
  detectEcosystems,
  ECOSYSTEM_ALLOW_HOSTS,
  egressHostMessage,
  egressSummaryMessage,
  isAllowedHost,
  isSafeHttpHeaderName,
  isTelemetryHost,
  sanitizeProxyHeaders,
  startEgressProxy,
  TELEMETRY_HOST_PATTERNS,
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

function makeRepo(kind: 'node' | 'empty' | 'pkg-dir' | 'dotnet' | 'node-dotnet' | 'sln-dir'): string {
  const dir = mkdtempSync(join(tmpdir(), 'egress-eco-'));
  cleanups.push(async () => rmSync(dir, { recursive: true, force: true }));
  if (kind === 'node') writeFileSync(join(dir, 'package.json'), '{}');
  if (kind === 'pkg-dir') mkdirSync(join(dir, 'package.json'));
  if (kind === 'dotnet' || kind === 'node-dotnet') writeFileSync(join(dir, 'App.sln'), '');
  if (kind === 'node-dotnet') writeFileSync(join(dir, 'package.json'), '{}');
  if (kind === 'sln-dir') mkdirSync(join(dir, 'App.sln'));
  return dir;
}

describe('buildEgressAllowlist', () => {
  it('pre-allows the npm and yarn registries for a Node repo (package.json fixture)', () => {
    const list = buildEgressAllowlist(['api.anthropic.com', 'github.com'], makeRepo('node'));
    expect(list).toEqual(['api.anthropic.com', 'github.com', 'registry.npmjs.org', 'registry.yarnpkg.com']);
    expect(isAllowedHost('registry.npmjs.org', list)).toBe(true);
  });

  it('marks registry.yarnpkg.com as on allowlist through the proxy for a Node repo', async () => {
    const calls: Array<[string, boolean]> = [];
    const list = buildEgressAllowlist(['github.com'], makeRepo('node'));
    const proxy = await proxyWith(list, calls);
    // onHost fires before the upstream connect, so don't wait on real DNS: hang up once it has fired.
    const sock = net.connect(proxy.port, '127.0.0.1');
    sock.on('error', () => {});
    sock.write('CONNECT registry.yarnpkg.com:443 HTTP/1.1\r\nHost: x\r\n\r\n');
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0));
    sock.destroy();
    expect(calls).toContainEqual(['registry.yarnpkg.com', true]);
    expect(egressSummaryMessage([...ECOSYSTEM_ALLOW_HOSTS.node], list)).toContain('all on allowlist');
  });

  it('does not pre-allow registries for a repo without package.json', () => {
    const configured = ['api.anthropic.com', 'github.com'];
    for (const dir of [makeRepo('empty'), join(tmpdir(), 'egress-eco-missing-dir'), '']) {
      const list = buildEgressAllowlist(configured, dir);
      expect(list).toEqual(configured);
      expect(isAllowedHost('registry.npmjs.org', list)).toBe(false);
    }
  });

  it('keeps an empty (deny-all) allowlist empty for a Node repo', () => {
    expect(buildEgressAllowlist([], makeRepo('node'))).toEqual([]);
    expect(buildEgressAllowlist([], makeRepo('dotnet'))).toEqual([]);
  });

  it('pre-allows api.nuget.org and *.nuget.org for a .NET repo (.sln fixture)', () => {
    const configured = ['api.anthropic.com', 'github.com'];
    const list = buildEgressAllowlist(configured, makeRepo('dotnet'));
    expect(list).toEqual([...configured, 'api.nuget.org', '*.nuget.org']);
    expect(isAllowedHost('api.nuget.org', list)).toBe(true);
    expect(isAllowedHost('globalcdn.nuget.org', list)).toBe(true);
    expect(egressSummaryMessage(['api.nuget.org', 'globalcdn.nuget.org'], list)).toContain('all on allowlist');
  });

  it('marks globalcdn.nuget.org as on allowlist through the proxy for a .NET repo', async () => {
    const calls: Array<[string, boolean]> = [];
    const list = buildEgressAllowlist(['github.com'], makeRepo('dotnet'));
    const proxy = await proxyWith(list, calls);
    const sock = net.connect(proxy.port, '127.0.0.1');
    sock.on('error', () => {});
    sock.write('CONNECT globalcdn.nuget.org:443 HTTP/1.1\r\nHost: x\r\n\r\n');
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0));
    sock.destroy();
    expect(calls).toContainEqual(['globalcdn.nuget.org', true]);
  });

  it('does not pre-allow NuGet hosts for a Node-only repo', () => {
    const configured = ['api.anthropic.com', 'github.com'];
    const list = buildEgressAllowlist(configured, makeRepo('node'));
    expect(list).toEqual([...configured, 'registry.npmjs.org', 'registry.yarnpkg.com']);
    expect(isAllowedHost('api.nuget.org', list)).toBe(false);
    expect(isAllowedHost('globalcdn.nuget.org', list)).toBe(false);
    expect(egressSummaryMessage(['api.nuget.org'], list)).toContain('not on allowlist: api.nuget.org');
  });

  it('adds both Node and NuGet hosts for a repo with package.json and a .sln', () => {
    expect(buildEgressAllowlist(['github.com'], makeRepo('node-dotnet'))).toEqual([
      'github.com',
      'registry.npmjs.org',
      'registry.yarnpkg.com',
      'api.nuget.org',
      '*.nuget.org',
    ]);
  });

  it('does not duplicate a configured *.nuget.org', () => {
    expect(buildEgressAllowlist(['*.NuGet.org'], makeRepo('dotnet'))).toEqual(['*.NuGet.org']);
  });

  it('does not duplicate a registry already configured, in any casing', () => {
    expect(buildEgressAllowlist(['Registry.NPMJS.org'], makeRepo('node'))).toEqual([
      'Registry.NPMJS.org',
      'registry.yarnpkg.com',
    ]);
  });
});

describe('detectEcosystems', () => {
  it('detects node from a root package.json file', () => {
    expect(detectEcosystems(makeRepo('node'))).toEqual(['node']);
  });

  it('detects nothing for an empty dir, a missing dir, or a package.json directory', () => {
    expect(detectEcosystems(makeRepo('empty'))).toEqual([]);
    expect(detectEcosystems(join(tmpdir(), 'egress-eco-missing-dir'))).toEqual([]);
    expect(detectEcosystems(makeRepo('pkg-dir'))).toEqual([]);
  });
});

describe('detectEcosystems (.NET)', () => {
  it.each(['App.sln', 'App.slnx', 'App.csproj', 'App.fsproj', 'App.vbproj', 'APP.SLN', 'global.json'])(
    'detects dotnet from a root %s file',
    (name) => {
      const dir = makeRepo('empty');
      writeFileSync(join(dir, name), '');
      expect(detectEcosystems(dir)).toEqual(['dotnet']);
    },
  );

  it('detects node and dotnet for a mixed repo', () => {
    expect(detectEcosystems(makeRepo('node-dotnet'))).toEqual(['node', 'dotnet']);
  });

  it('does not detect dotnet for a .sln directory', () => {
    expect(detectEcosystems(makeRepo('sln-dir'))).toEqual([]);
  });
});

describe('isAllowedHost wildcard', () => {
  it('matches *. wildcard entries against subdomains only', () => {
    expect(isAllowedHost('globalcdn.nuget.org', ['*.nuget.org'])).toBe(true);
    expect(isAllowedHost('a.b.nuget.org', ['*.NuGet.org'])).toBe(true);
    expect(isAllowedHost('nuget.org', ['*.nuget.org'])).toBe(false);
    expect(isAllowedHost('evilnuget.org', ['*.nuget.org'])).toBe(false);
    expect(isAllowedHost('x.com', ['*'])).toBe(false);
    expect(isAllowedHost('x.com', ['*.'])).toBe(false);
    expect(isAllowedHost('afoo.com', ['*foo.com'])).toBe(false);
  });
});

describe('egressSummaryMessage telemetry (#2664)', () => {
  it('reports a datadoghq host as telemetry, separately from unlisted hosts', () => {
    expect(egressSummaryMessage(['a.com', 'http-intake.logs.datadoghq.com', 'github.com'], ['github.com'])).toBe(
      '3 host(s) used, 1 not on allowlist: a.com; 1 telemetry not on allowlist: http-intake.logs.datadoghq.com',
    );
  });

  it('keeps a non-telemetry unlisted host in the unlisted bucket, not telemetry', () => {
    const msg = egressSummaryMessage(['a.com', 'x.datadoghq.com'], []);
    expect(msg).toContain('1 not on allowlist: a.com');
    expect(msg.split('telemetry not on allowlist:')[1]).not.toContain('a.com');
    expect(egressSummaryMessage(['evil-datadoghq.com'], [])).toBe(
      '1 host(s) used, 1 not on allowlist: evil-datadoghq.com',
    );
  });

  it('lists only telemetry hosts in the telemetry bucket and treats allowlisted ones as listed', () => {
    expect(egressSummaryMessage(['x.datadoghq.com'], [])).toBe(
      '1 host(s) used, 1 telemetry not on allowlist: x.datadoghq.com',
    );
    expect(egressSummaryMessage(['x.datadoghq.com'], ['*.datadoghq.com'])).toBe('1 host(s) used, all on allowlist');
    expect(egressSummaryMessage([], [])).toBe('0 host(s) used, all on allowlist');
  });
});

describe('isTelemetryHost (#2664)', () => {
  it('matches the apex, subdomains, and uppercase', () => {
    expect(isTelemetryHost('datadoghq.com')).toBe(true);
    expect(isTelemetryHost('http-intake.logs.datadoghq.com')).toBe(true);
    expect(isTelemetryHost('X.DATADOGHQ.COM')).toBe(true);
  });

  it('rejects lookalikes and unrelated hosts', () => {
    expect(isTelemetryHost('evil-datadoghq.com')).toBe(false);
    expect(isTelemetryHost('github.com')).toBe(false);
  });
});

describe('egressHostMessage (#2664)', () => {
  it('tags telemetry hosts and leaves others unchanged', () => {
    expect(egressHostMessage('x.datadoghq.com', false)).toBe('x.datadoghq.com (telemetry, not on allowlist)');
    expect(egressHostMessage('x.datadoghq.com', true)).toBe('x.datadoghq.com (telemetry, on allowlist)');
    expect(egressHostMessage('a.com', false)).toBe('a.com (not on allowlist)');
    expect(egressHostMessage('a.com', true)).toBe('a.com (on allowlist)');
  });
});

describe('telemetry block switch (#2667)', () => {
  it('refuses a CONNECT to a telemetry host with 403 and still reports it as telemetry when blockTelemetry is on', async () => {
    const calls: Array<[string, boolean]> = [];
    const proxy = await startEgressProxy({
      allowHosts: ['github.com'],
      blockTelemetry: true,
      onHost: (h, a) => calls.push([h, a]),
    });
    cleanups.push(() => proxy.close());
    const out = await rawExchange(proxy.port, 'CONNECT x.datadoghq.com:443 HTTP/1.1\r\nHost: x\r\n\r\n');
    expect(out).toContain('403');
    expect(calls).toEqual([['x.datadoghq.com', false]]);
    expect(egressSummaryMessage(proxy.hosts(), ['github.com'])).toBe(
      '1 host(s) used, 1 telemetry not on allowlist: x.datadoghq.com',
    );
  });

  it('refuses absolute-form HTTP to a telemetry host with 403', async () => {
    const proxy = await startEgressProxy({ allowHosts: ['github.com'], blockTelemetry: true });
    cleanups.push(() => proxy.close());
    const out = await rawExchange(
      proxy.port,
      'GET http://X.DATADOGHQ.COM/v1 HTTP/1.1\r\nHost: x.datadoghq.com\r\nConnection: close\r\n\r\n',
    );
    expect(out).toContain('403');
    expect(proxy.hosts()).toEqual(['x.datadoghq.com']);
  });

  it('blocks an allowlisted telemetry host when the switch is on', async () => {
    const proxy = await startEgressProxy({ allowHosts: ['*.datadoghq.com'], blockTelemetry: true });
    cleanups.push(() => proxy.close());
    const out = await rawExchange(proxy.port, 'CONNECT x.datadoghq.com:443 HTTP/1.1\r\nHost: x\r\n\r\n');
    expect(out).toContain('403');
  });

  it.each([undefined, false])('forwards a telemetry host when blockTelemetry is %s', async (blockTelemetry) => {
    const proxy = await startEgressProxy({ allowHosts: ['github.com'], blockTelemetry });
    cleanups.push(() => proxy.close());
    // The upstream is a real host: do not wait for it to resolve or answer, just for the proxy's decision.
    const out = await new Promise<string>((resolve) => {
      const sock = net.connect(proxy.port, '127.0.0.1');
      let data = '';
      const done = (): void => {
        sock.destroy();
        resolve(data);
      };
      const timer = setTimeout(done, 1000);
      sock.on('data', (d) => {
        data += d.toString();
        clearTimeout(timer);
        done();
      });
      sock.on('close', () => {
        clearTimeout(timer);
        done();
      });
      sock.on('error', () => undefined);
      sock.write('CONNECT x.datadoghq.com:443 HTTP/1.1\r\nHost: x\r\n\r\n');
    });
    expect(out).not.toContain('403');
    expect(proxy.hosts()).toEqual(['x.datadoghq.com']);
  });

  it('still forwards non-telemetry hosts when the switch is on', async () => {
    const upstreamPort = await startUpstream();
    const proxy = await startEgressProxy({ allowHosts: [], blockTelemetry: true });
    cleanups.push(() => proxy.close());
    const { status, socket } = await connectTunnel(proxy, `localhost:${upstreamPort}`);
    socket.destroy();
    expect(status).toBe(200);
  });
});

const EGRESS_DOC = fileURLToPath(new URL('../../../../docs/egress.md', import.meta.url));

describe('docs/egress.md', () => {
  const doc = () => readFileSync(EGRESS_DOC, 'utf8');
  it('lists every ECOSYSTEM_ALLOW_HOSTS host and says they apply only to detected ecosystems', () => {
    const text = doc();
    for (const host of Object.values(ECOSYSTEM_ALLOW_HOSTS).flat()) expect(text).toContain(`\`${host}\``);
    expect(text).toMatch(/only for ecosystems detected/i);
  });
  it('lists every TELEMETRY_HOST_PATTERNS entry and names sandbox.network.blockTelemetry', () => {
    const text = doc();
    for (const host of TELEMETRY_HOST_PATTERNS) expect(text).toContain(`\`${host}\``);
    expect(text).toContain('sandbox.network.blockTelemetry');
    expect(text).toMatch(/telemetry, not on allowlist/);
  });
});
