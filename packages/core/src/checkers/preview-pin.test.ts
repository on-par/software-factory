import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { pinnedLookup, probePinned, vetPreviewHost } from './preview-pin.js';

const PUBLIC = '93.184.216.34';

describe('vetPreviewHost', () => {
  it('pins the first address a public hostname resolves to', async () => {
    const resolveHost = vi.fn(async () => [PUBLIC, '2606:2800:220:1::1']);
    expect(await vetPreviewHost('https://p.example.com/', resolveHost)).toEqual({
      ok: true,
      pin: { address: PUBLIC, family: 4 },
    });
    expect(resolveHost).toHaveBeenCalledWith('p.example.com');
  });

  it('pins an IPv6 address with family 6', async () => {
    const vet = await vetPreviewHost('https://p.example.com/', async () => ['2606:2800:220:1::1']);
    expect(vet).toEqual({ ok: true, pin: { address: '2606:2800:220:1::1', family: 6 } });
  });

  it('pins an IP literal host to itself without resolving it', async () => {
    const resolveHost = vi.fn(async () => ['10.0.0.5']);
    expect(await vetPreviewHost('https://[2606:4700::1111]/', resolveHost)).toEqual({
      ok: true,
      pin: { address: '2606:4700::1111', family: 6 },
    });
    expect(resolveHost).not.toHaveBeenCalled();
  });

  it('refuses a hostname when any resolved address is not public', async () => {
    const vet = await vetPreviewHost('https://p.example.com/', async () => [PUBLIC, '169.254.169.254']);
    expect(vet).toEqual({
      ok: false,
      reason: 'preview host p.example.com resolves to non-public address 169.254.169.254',
    });
  });

  it('refuses a hostname that resolves to nothing', async () => {
    const vet = await vetPreviewHost('https://p.example.com/', async () => []);
    expect(vet).toEqual({ ok: false, reason: 'preview host p.example.com resolves to no address' });
  });

  it('refuses a URL that is not a public http(s) host', async () => {
    const vet = await vetPreviewHost('http://localhost:3000/?t=1', async () => [PUBLIC]);
    expect(vet).toEqual({ ok: false, reason: 'preview URL http://localhost:3000/?*** is not a public http(s) host' });
  });
});

describe('pinnedLookup', () => {
  const pin = { address: PUBLIC, family: 4 } as const;

  it('answers every hostname with the pinned address', () => {
    const callback = vi.fn();
    pinnedLookup(pin)('rebound.example.com', {}, callback);
    expect(callback).toHaveBeenCalledWith(null, PUBLIC, 4);
  });

  it('answers an all-addresses lookup with only the pinned address', () => {
    const callback = vi.fn();
    pinnedLookup(pin)('rebound.example.com', { all: true }, callback);
    expect(callback).toHaveBeenCalledWith(null, [{ address: PUBLIC, family: 4 }]);
  });
});

describe('probePinned', () => {
  const servers: Server[] = [];
  afterEach(() => servers.splice(0).forEach((server) => server.close()));

  async function listen(status: number) {
    const seen: { url?: string; headers?: IncomingHttpHeaders } = {};
    const server = createServer((req, res) => {
      seen.url = req.url;
      seen.headers = req.headers;
      res.writeHead(status).end();
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('test server has no TCP port');
    return { port: address.port, seen, server };
  }

  it('connects to the pinned address while sending the preview hostname as Host', async () => {
    const { port, seen } = await listen(204);
    const status = await probePinned(`http://never-resolved.example.com:${port}/healthz?x=1`, {
      address: '127.0.0.1',
      family: 4,
    });
    expect(status).toBe(204);
    expect(seen.url).toBe('/healthz?x=1');
    expect(seen.headers?.host).toBe(`never-resolved.example.com:${port}`);
  });

  it('reports no response when nothing answers at the pinned address', async () => {
    const { port, server } = await listen(200);
    await new Promise((resolve) => server.close(resolve));
    expect(await probePinned(`http://p.example.com:${port}/`, { address: '127.0.0.1', family: 4 })).toBeNull();
  });
});
