import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createFactorydServer, DEFAULT_FACTORYD_PORT, type FactorydServer } from './factoryd-http.js';
import { dispatchableRepos, loadRegistry, type RepoRegistry } from './registry.js';

function writeRegistry(file: string, registry: RepoRegistry): Promise<void> {
  return writeFile(file, JSON.stringify(registry));
}

function get(
  port: number,
  path: string,
  method = 'GET',
  body?: string,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolvePromise, reject) => {
    const headers: Record<string, string> = {};
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(Buffer.byteLength(body));
    }
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let responseBody = '';
      res.on('data', (chunk) => (responseBody += chunk));
      res.on('end', () => resolvePromise({ status: res.statusCode ?? 0, headers: res.headers, body: responseBody }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
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

  it('rejects a non-GET/POST method on /repos with 405 and an Allow: GET, POST header', async () => {
    const lines: string[] = [];
    factoryd = createFactorydServer({ registryFile, port: 0, log: (line) => lines.push(line) });
    await factoryd.start();

    const { status, headers, body } = await get(factoryd.port, '/repos', 'DELETE');
    expect(status).toBe(405);
    expect(headers.allow).toBe('GET, POST');
    expect(JSON.parse(body)).toEqual({ error: 'method not allowed' });
    expect(lines).toEqual(['DELETE /repos 405']);
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

  describe('POST /repos', () => {
    it('attaches a valid checkout, returns 201, and the entry then shows up via GET (acceptance criterion 1)', async () => {
      const lines: string[] = [];
      factoryd = createFactorydServer({
        registryFile,
        port: 0,
        log: (line) => lines.push(line),
        attachDeps: {
          readOrigin: async () => 'git@github.com:on-par/software-factory.git',
          fileExists: async () => true,
          now: () => new Date('2026-08-19T12:00:00.000Z'),
        },
      });
      await factoryd.start();

      const { status, body } = await get(
        factoryd.port,
        '/repos',
        'POST',
        JSON.stringify({ repo: 'on-par/software-factory', path: '/tmp/checkout' }),
      );
      expect(status).toBe(201);
      expect(JSON.parse(body)).toEqual({
        repo: {
          slug: 'on-par/software-factory',
          path: '/tmp/checkout',
          attachedAt: '2026-08-19T12:00:00.000Z',
          state: 'active',
        },
      });

      const listing = await get(factoryd.port, '/repos');
      expect(JSON.parse(listing.body)).toEqual({
        repos: [
          {
            slug: 'on-par/software-factory',
            path: '/tmp/checkout',
            attachedAt: '2026-08-19T12:00:00.000Z',
            state: 'active',
          },
        ],
      });
      expect(lines).toEqual(['POST /repos 201', 'GET /repos 200']);
    });

    it('rejects an origin mismatch with 400 and leaves the registry unchanged (acceptance criterion 2)', async () => {
      factoryd = createFactorydServer({
        registryFile,
        port: 0,
        attachDeps: { readOrigin: async () => 'git@github.com:on-par/other-repo.git' },
      });
      await factoryd.start();

      const { status, body } = await get(
        factoryd.port,
        '/repos',
        'POST',
        JSON.stringify({ repo: 'on-par/software-factory', path: '/tmp/checkout' }),
      );
      expect(status).toBe(400);
      expect(JSON.parse(body)).toEqual({
        error: 'origin is on-par/other-repo, not on-par/software-factory',
        reason: 'origin-mismatch',
      });

      const listing = await get(factoryd.port, '/repos');
      expect(JSON.parse(listing.body)).toEqual({ repos: [] });
    });

    it('rejects a missing .factory/config.json with 400 (acceptance criterion 3)', async () => {
      factoryd = createFactorydServer({
        registryFile,
        port: 0,
        attachDeps: {
          readOrigin: async () => 'git@github.com:on-par/software-factory.git',
          fileExists: async () => false,
        },
      });
      await factoryd.start();

      const { status, body } = await get(
        factoryd.port,
        '/repos',
        'POST',
        JSON.stringify({ repo: 'on-par/software-factory', path: '/tmp/checkout' }),
      );
      expect(status).toBe(400);
      expect(JSON.parse(body)).toEqual({
        error: expect.stringContaining('.factory/config.json not found'),
        reason: 'missing-factory-config',
      });

      const listing = await get(factoryd.port, '/repos');
      expect(JSON.parse(listing.body)).toEqual({ repos: [] });
    });

    it('rejects a non-JSON body with 400 invalid-request', async () => {
      factoryd = createFactorydServer({ registryFile, port: 0 });
      await factoryd.start();

      const { status, body } = await get(factoryd.port, '/repos', 'POST', 'not json{{{');
      expect(status).toBe(400);
      expect(JSON.parse(body)).toEqual({ error: 'invalid JSON body', reason: 'invalid-request' });
    });

    it('rejects a body over 64 KiB with 413', async () => {
      factoryd = createFactorydServer({ registryFile, port: 0 });
      await factoryd.start();

      const oversized = JSON.stringify({ repo: 'on-par/software-factory', path: '/tmp/' + 'x'.repeat(70 * 1024) });
      const { status, body } = await get(factoryd.port, '/repos', 'POST', oversized);
      expect(status).toBe(413);
      expect(JSON.parse(body)).toEqual({ error: 'request body too large', reason: 'invalid-request' });
    });

    it('emits exactly one log line per POST', async () => {
      const lines: string[] = [];
      factoryd = createFactorydServer({
        registryFile,
        port: 0,
        log: (line) => lines.push(line),
        attachDeps: { readOrigin: async () => 'git@github.com:on-par/other-repo.git' },
      });
      await factoryd.start();

      await get(factoryd.port, '/repos', 'POST', JSON.stringify({ repo: 'on-par/software-factory', path: '/tmp/x' }));
      expect(lines).toEqual(['POST /repos 400']);
    });
  });

  describe('POST /repos/<owner>/<name>/pause|resume', () => {
    it('pauses an active repo, excludes it from dispatchableRepos, and GET /repos agrees (acceptance criterion 1)', async () => {
      await writeRegistry(registryFile, {
        version: 1,
        repos: {
          'on-par/software-factory': {
            path: '/repos/software-factory',
            attachedAt: '2026-08-19T12:00:00.000Z',
            state: 'active',
          },
        },
      });
      factoryd = createFactorydServer({ registryFile, port: 0 });
      await factoryd.start();

      const { status, body } = await get(factoryd.port, '/repos/on-par/software-factory/pause', 'POST');
      expect(status).toBe(200);
      expect(JSON.parse(body)).toEqual({
        repo: {
          slug: 'on-par/software-factory',
          path: '/repos/software-factory',
          attachedAt: '2026-08-19T12:00:00.000Z',
          state: 'paused',
        },
      });

      const listing = await get(factoryd.port, '/repos');
      expect(JSON.parse(listing.body)).toEqual({
        repos: [
          {
            slug: 'on-par/software-factory',
            path: '/repos/software-factory',
            attachedAt: '2026-08-19T12:00:00.000Z',
            state: 'paused',
          },
        ],
      });
      expect(dispatchableRepos(await loadRegistry(registryFile))).toEqual([]);
    });

    it('resumes a paused repo back to active and it reappears in dispatchableRepos (acceptance criterion 2)', async () => {
      await writeRegistry(registryFile, {
        version: 1,
        repos: {
          'on-par/software-factory': {
            path: '/repos/software-factory',
            attachedAt: '2026-08-19T12:00:00.000Z',
            state: 'paused',
          },
        },
      });
      factoryd = createFactorydServer({ registryFile, port: 0 });
      await factoryd.start();

      const { status, body } = await get(factoryd.port, '/repos/on-par/software-factory/resume', 'POST');
      expect(status).toBe(200);
      expect(JSON.parse(body)).toEqual({
        repo: {
          slug: 'on-par/software-factory',
          path: '/repos/software-factory',
          attachedAt: '2026-08-19T12:00:00.000Z',
          state: 'active',
        },
      });

      const listing = await get(factoryd.port, '/repos');
      expect(JSON.parse(listing.body)).toEqual({
        repos: [
          {
            slug: 'on-par/software-factory',
            path: '/repos/software-factory',
            attachedAt: '2026-08-19T12:00:00.000Z',
            state: 'active',
          },
        ],
      });
      expect(dispatchableRepos(await loadRegistry(registryFile)).map((r) => r.slug)).toEqual([
        'on-par/software-factory',
      ]);
    });

    it('returns 404 unknown-repo for a slug not in the registry', async () => {
      factoryd = createFactorydServer({ registryFile, port: 0 });
      await factoryd.start();

      const { status, body } = await get(factoryd.port, '/repos/on-par/nope/pause', 'POST');
      expect(status).toBe(404);
      expect(JSON.parse(body)).toEqual({ error: 'on-par/nope is not attached', reason: 'unknown-repo' });
    });

    it('returns 409 detached for a detached tombstone', async () => {
      await writeRegistry(registryFile, {
        version: 1,
        repos: {
          'on-par/software-factory': {
            path: '/repos/software-factory',
            attachedAt: '2026-08-19T12:00:00.000Z',
            state: 'detached',
          },
        },
      });
      factoryd = createFactorydServer({ registryFile, port: 0 });
      await factoryd.start();

      const { status, body } = await get(factoryd.port, '/repos/on-par/software-factory/resume', 'POST');
      expect(status).toBe(409);
      expect(JSON.parse(body)).toEqual({
        error: 'on-par/software-factory is detached; re-attach it with POST /repos',
        reason: 'detached',
      });
    });

    it('rejects a non-POST method with 405 and Allow: POST', async () => {
      await writeRegistry(registryFile, {
        version: 1,
        repos: {
          'on-par/software-factory': {
            path: '/repos/software-factory',
            attachedAt: '2026-08-19T12:00:00.000Z',
            state: 'active',
          },
        },
      });
      factoryd = createFactorydServer({ registryFile, port: 0 });
      await factoryd.start();

      const { status, headers, body } = await get(factoryd.port, '/repos/on-par/software-factory/pause', 'GET');
      expect(status).toBe(405);
      expect(headers.allow).toBe('POST');
      expect(JSON.parse(body)).toEqual({ error: 'method not allowed' });
    });

    it('returns 404 for an unknown action segment', async () => {
      factoryd = createFactorydServer({ registryFile, port: 0 });
      await factoryd.start();

      const { status, body } = await get(factoryd.port, '/repos/on-par/x/bogus', 'POST');
      expect(status).toBe(404);
      expect(JSON.parse(body)).toEqual({ error: 'not found' });
    });

    it('treats a trailing slash and a query string the same as the bare path', async () => {
      await writeRegistry(registryFile, {
        version: 1,
        repos: {
          'on-par/x': { path: '/repos/x', attachedAt: '2026-08-19T12:00:00.000Z', state: 'active' },
        },
      });
      factoryd = createFactorydServer({ registryFile, port: 0 });
      await factoryd.start();

      expect((await get(factoryd.port, '/repos/on-par/x/pause/', 'POST')).status).toBe(200);
      expect((await get(factoryd.port, '/repos/on-par/x/pause?foo=1', 'POST')).status).toBe(200);
    });

    it('emits exactly one log line per pause/resume request', async () => {
      await writeRegistry(registryFile, {
        version: 1,
        repos: {
          'on-par/software-factory': {
            path: '/repos/software-factory',
            attachedAt: '2026-08-19T12:00:00.000Z',
            state: 'active',
          },
        },
      });
      const lines: string[] = [];
      factoryd = createFactorydServer({ registryFile, port: 0, log: (line) => lines.push(line) });
      await factoryd.start();

      await get(factoryd.port, '/repos/on-par/software-factory/pause', 'POST');
      expect(lines).toEqual(['POST /repos/on-par/software-factory/pause 200']);
    });
  });

  describe('DELETE /repos/<owner>/<name>', () => {
    it('drains an active repo, tombstones it, and excludes it from dispatchableRepos', async () => {
      await writeRegistry(registryFile, {
        version: 1,
        repos: {
          'on-par/software-factory': {
            path: '/repos/software-factory',
            attachedAt: '2026-08-19T12:00:00.000Z',
            state: 'active',
          },
        },
      });
      factoryd = createFactorydServer({
        registryFile,
        port: 0,
        detachDeps: { readLaneStatuses: async () => ['merged'] },
      });
      await factoryd.start();

      const { status, body } = await get(factoryd.port, '/repos/on-par/software-factory', 'DELETE');
      expect(status).toBe(200);
      expect(JSON.parse(body)).toEqual({
        repo: {
          slug: 'on-par/software-factory',
          path: '/repos/software-factory',
          attachedAt: '2026-08-19T12:00:00.000Z',
          state: 'detached',
        },
        forced: false,
      });

      expect(dispatchableRepos(await loadRegistry(registryFile))).toEqual([]);
    });

    it('?force=true skips the drain entirely and reports forced: true', async () => {
      await writeRegistry(registryFile, {
        version: 1,
        repos: {
          'on-par/software-factory': {
            path: '/repos/software-factory',
            attachedAt: '2026-08-19T12:00:00.000Z',
            state: 'active',
          },
        },
      });
      factoryd = createFactorydServer({
        registryFile,
        port: 0,
        detachDeps: {
          readLaneStatuses: async () => {
            throw new Error('must not be called when forced');
          },
        },
      });
      await factoryd.start();

      const { status, body } = await get(factoryd.port, '/repos/on-par/software-factory?force=true', 'DELETE');
      expect(status).toBe(200);
      expect(JSON.parse(body)).toEqual({
        repo: {
          slug: 'on-par/software-factory',
          path: '/repos/software-factory',
          attachedAt: '2026-08-19T12:00:00.000Z',
          state: 'detached',
        },
        forced: true,
      });
    });

    it.each(['?force=false', '?force=1', ''])('takes the drain path for %s', async (query) => {
      await writeRegistry(registryFile, {
        version: 1,
        repos: {
          'on-par/software-factory': {
            path: '/repos/software-factory',
            attachedAt: '2026-08-19T12:00:00.000Z',
            state: 'active',
          },
        },
      });
      let called = false;
      factoryd = createFactorydServer({
        registryFile,
        port: 0,
        detachDeps: {
          readLaneStatuses: async () => {
            called = true;
            return ['merged'];
          },
        },
      });
      await factoryd.start();

      const { status, body } = await get(factoryd.port, `/repos/on-par/software-factory${query}`, 'DELETE');
      expect(status).toBe(200);
      expect(JSON.parse(body).forced).toBe(false);
      expect(called).toBe(true);
    });

    it('a bare ?force query param forces the detach', async () => {
      await writeRegistry(registryFile, {
        version: 1,
        repos: {
          'on-par/software-factory': {
            path: '/repos/software-factory',
            attachedAt: '2026-08-19T12:00:00.000Z',
            state: 'active',
          },
        },
      });
      factoryd = createFactorydServer({
        registryFile,
        port: 0,
        detachDeps: {
          readLaneStatuses: async () => {
            throw new Error('must not be called when forced');
          },
        },
      });
      await factoryd.start();

      const { status, body } = await get(factoryd.port, '/repos/on-par/software-factory?force', 'DELETE');
      expect(status).toBe(200);
      expect(JSON.parse(body).forced).toBe(true);
    });

    it('returns 404 unknown-repo for a slug not in the registry', async () => {
      factoryd = createFactorydServer({ registryFile, port: 0 });
      await factoryd.start();

      const { status, body } = await get(factoryd.port, '/repos/on-par/nope', 'DELETE');
      expect(status).toBe(404);
      expect(JSON.parse(body)).toEqual({ error: 'on-par/nope is not attached', reason: 'unknown-repo' });
    });

    it('returns 409 drain-timeout and leaves the entry draining', async () => {
      await writeRegistry(registryFile, {
        version: 1,
        repos: {
          'on-par/software-factory': {
            path: '/repos/software-factory',
            attachedAt: '2026-08-19T12:00:00.000Z',
            state: 'active',
          },
        },
      });
      factoryd = createFactorydServer({
        registryFile,
        port: 0,
        detachDeps: {
          readLaneStatuses: async () => ['building'],
          drainTimeoutMs: 0,
          sleep: async () => {},
        },
      });
      await factoryd.start();

      const { status, body } = await get(factoryd.port, '/repos/on-par/software-factory', 'DELETE');
      expect(status).toBe(409);
      const parsed = JSON.parse(body);
      expect(parsed.reason).toBe('drain-timeout');

      expect((await loadRegistry(registryFile)).repos['on-par/software-factory']?.state).toBe('draining');
    });

    it('rejects a non-DELETE method with 405 and Allow: DELETE', async () => {
      await writeRegistry(registryFile, {
        version: 1,
        repos: {
          'on-par/software-factory': {
            path: '/repos/software-factory',
            attachedAt: '2026-08-19T12:00:00.000Z',
            state: 'active',
          },
        },
      });
      factoryd = createFactorydServer({ registryFile, port: 0 });
      await factoryd.start();

      const { status, headers, body } = await get(factoryd.port, '/repos/on-par/software-factory', 'GET');
      expect(status).toBe(405);
      expect(headers.allow).toBe('DELETE');
      expect(JSON.parse(body)).toEqual({ error: 'method not allowed' });
    });

    it('treats a trailing slash and a query string as routing to the same slug', async () => {
      await writeRegistry(registryFile, {
        version: 1,
        repos: {
          'on-par/x': { path: '/repos/x', attachedAt: '2026-08-19T12:00:00.000Z', state: 'active' },
        },
      });
      factoryd = createFactorydServer({
        registryFile,
        port: 0,
        detachDeps: { readLaneStatuses: async () => ['merged'] },
      });
      await factoryd.start();

      expect((await get(factoryd.port, '/repos/on-par/x/', 'DELETE')).status).toBe(200);
    });

    it('emits exactly one log line per DELETE request', async () => {
      await writeRegistry(registryFile, {
        version: 1,
        repos: {
          'on-par/software-factory': {
            path: '/repos/software-factory',
            attachedAt: '2026-08-19T12:00:00.000Z',
            state: 'active',
          },
        },
      });
      const lines: string[] = [];
      factoryd = createFactorydServer({
        registryFile,
        port: 0,
        log: (line) => lines.push(line),
        detachDeps: { readLaneStatuses: async () => ['merged'] },
      });
      await factoryd.start();

      await get(factoryd.port, '/repos/on-par/software-factory', 'DELETE');
      expect(lines).toEqual(['DELETE /repos/on-par/software-factory 200']);
    });
  });
});
