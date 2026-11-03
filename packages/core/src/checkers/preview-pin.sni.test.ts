import type { Server } from 'node:net';
import { createServer } from 'node:tls';

import { afterEach, describe, expect, it } from 'vitest';

import { probePinned } from './preview-pin.js';

const LOOPBACK = { address: '127.0.0.1', family: 4 } as const;

describe('probePinned over https', () => {
  const servers: Server[] = [];
  const closed = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()));
  afterEach(async () => {
    await Promise.all(servers.splice(0).map(closed));
  });

  async function listenForClientHello() {
    const seen: { servername?: string } = {};
    const server = createServer({
      SNICallback: (servername, callback) => {
        seen.servername = servername;
        callback(new Error('test server has no certificate'));
      },
    });
    servers.push(server);
    const handshakeEnded = new Promise<void>((resolve) => server.once('tlsClientError', () => resolve()));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('test server has no TCP port');
    return { port: address.port, seen, handshakeEnded };
  }

  it('sends the preview hostname, not the pinned address, as the TLS server name', async () => {
    const { port, seen, handshakeEnded } = await listenForClientHello();
    expect(await probePinned(`https://never-resolved.example.com:${port}/`, LOOPBACK)).toBeNull();
    await handshakeEnded;
    expect(seen.servername).toBe('never-resolved.example.com');
  });

  it('sends no TLS server name when the preview host is an IP literal', async () => {
    const { port, seen, handshakeEnded } = await listenForClientHello();
    expect(await probePinned(`https://127.0.0.1:${port}/`, LOOPBACK)).toBeNull();
    await handshakeEnded;
    expect(seen.servername).toBeUndefined();
  });
});
