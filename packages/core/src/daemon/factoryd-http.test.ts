import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createFactorydServer, DEFAULT_FACTORYD_PORT, type FactorydServer } from './factoryd-http.js';
import type { RepoRegistry } from './registry.js';

function writeRegistry(file: string, registry: RepoRegistry): Promise<void> {
  return writeFile(file, JSON.stringify(registry));
}

function get(
  port: number,
  path: string,
  method = 'GET',
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolvePromise, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolvePromise({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('createFactorydServer', () => {
  let dir: string;
  let registryFile: string;
  let factoryd: FactorydServer | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'factoryd-http-'));
    registryFile = join(dir, 'registry.json');
  });

  afterEach(async () => {
    await factoryd?.stop();
    factoryd = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  it('binds loopback only', async () => {
    factoryd = createFactorydServer({ registryFile, port: 0 });
    await factoryd.start();
    const addr = factoryd.server.address();
    expect(typeof addr === 'object' && addr?.address).toBe('127.0.0.1');
  });

  it('constructs without touching the real home directory and defaults port before start', () => {
    factoryd = createFactorydServer();
    expect(factoryd.port).toBe(DEFAULT_FACTORYD_PORT);
  });

  it('lists registered repos with their state in ascending slug order (acceptance scenario 1)', async () => {
    await writeRegistry(registryFile, {
      version: 1,
      repos: {
        'on-par/sound-buddy': { path: '/repos/sound-buddy', attachedAt: '2026-01-01T00:00:00.000Z', state: 'active' },
        'on-par/software-factory': {
          path: '/repos/software-factory',
          attachedAt: '2026-01-02T00:00:00.000Z',
          state: 'paused',
        },
      },
    });

    factoryd = createFactorydServer({ registryFile, port: 0 });
    await factoryd.start();

    const { status, headers, body } = await get(factoryd.port, '/repos');
    expect(status).toBe(200);
    expect(headers['content-type']).toMatch(/^application\/json/);
    expect(JSON.parse(body)).toEqual({
      repos: [
        {
          slug: 'on-par/software-factory',
          path: '/repos/software-factory',
          attachedAt: '2026-01-02T00:00:00.000Z',
          state: 'paused',
        },
        {
          slug: 'on-par/sound-buddy',
          path: '/repos/sound-buddy',
          attachedAt: '2026-01-01T00:00:00.000Z',
          state: 'active',
        },
      ],
    });
  });

  it('returns an empty list for a missing registry (acceptance scenario 2)', async () => {
    factoryd = createFactorydServer({ registryFile: join(dir, 'nope.json'), port: 0 });
    await factoryd.start();

    const { status, body } = await get(factoryd.port, '/repos');
    expect(status).toBe(200);
    expect(JSON.parse(body)).toEqual({ repos: [] });
  });

  it('returns an empty list for a corrupt registry file', async () => {
    await writeFile(registryFile, 'not json{{{');
    factoryd = createFactorydServer({ registryFile, port: 0 });
    await factoryd.start();

    const { status, body } = await get(factoryd.port, '/repos');
    expect(status).toBe(200);
    expect(JSON.parse(body)).toEqual({ repos: [] });
  });

  it('emits exactly one log line per handled request', async () => {
    const lines: string[] = [];
    factoryd = createFactorydServer({ registryFile, port: 0, log: (line) => lines.push(line) });
    await factoryd.start();

    await get(factoryd.port, '/repos');
    expect(lines).toEqual(['GET /repos 200']);
  });

  it('rejects a non-GET method on /repos with 405 and an Allow: GET header', async () => {
    const lines: string[] = [];
    factoryd = createFactorydServer({ registryFile, port: 0, log: (line) => lines.push(line) });
    await factoryd.start();

    const { status, headers, body } = await get(factoryd.port, '/repos', 'POST');
    expect(status).toBe(405);
    expect(headers.allow).toBe('GET');
    expect(JSON.parse(body)).toEqual({ error: 'method not allowed' });
    expect(lines).toEqual(['POST /repos 405']);
  });

  it('returns 404 for an unknown path', async () => {
    factoryd = createFactorydServer({ registryFile, port: 0 });
    await factoryd.start();

    const { status, body } = await get(factoryd.port, '/nope');
    expect(status).toBe(404);
    expect(JSON.parse(body)).toEqual({ error: 'not found' });
  });

  it('treats a query string and a trailing slash as /repos', async () => {
    factoryd = createFactorydServer({ registryFile, port: 0 });
    await factoryd.start();

    expect((await get(factoryd.port, '/repos?foo=1')).status).toBe(200);
    expect((await get(factoryd.port, '/repos/')).status).toBe(200);
  });

  it('closes the listener on stop() and releases the port', async () => {
    factoryd = createFactorydServer({ registryFile, port: 0 });
    await factoryd.start();
    const port = factoryd.port;

    await factoryd.stop();
    expect(factoryd.server.listening).toBe(false);
    await expect(get(port, '/repos')).rejects.toThrow();
  });
});
