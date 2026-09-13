import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getFactoryPaths } from '../config/index.js';
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
    vi.stubEnv('FACTORY_MERGE', '');
    vi.stubEnv('FACTORY_MERGE_ADMIN', '');
    dir = await mkdtemp(join(tmpdir(), 'factoryd-http-'));
    registryFile = join(dir, 'registry.json');
  });

  afterEach(async () => {
    await factoryd?.stop();
    factoryd = undefined;
    vi.unstubAllEnvs();
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
        'owner/example-app': { path: '/repos/example-app', attachedAt: '2026-01-01T00:00:00.000Z', state: 'active' },
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
          slug: 'owner/example-app',
          path: '/repos/example-app',
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

    it('persists an attach across a daemon restart: a fresh server over the same file still lists it (#1403)', async () => {
      factoryd = createFactorydServer({
        registryFile,
        port: 0,
        attachDeps: {
          readOrigin: async () => 'git@github.com:on-par/software-factory.git',
          fileExists: async () => true,
          now: () => new Date('2026-08-19T12:00:00.000Z'),
        },
      });
      await factoryd.start();
      await get(
        factoryd.port,
        '/repos',
        'POST',
        JSON.stringify({ repo: 'on-par/software-factory', path: '/tmp/checkout' }),
      );
      await factoryd.stop();

      // Simulates a reload: a brand-new server instance (as a fresh daemon start or a fresh
      // dashboard load would see), reading the same registry file from scratch.
      factoryd = createFactorydServer({ registryFile, port: 0 });
      await factoryd.start();

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

  describe('GET/PUT /repos/<owner>/<name>/policy', () => {
    async function writeCheckoutRegistry(): Promise<string> {
      const checkoutDir = join(dir, 'checkout');
      await writeRegistry(registryFile, {
        version: 1,
        repos: {
          'on-par/software-factory': { path: checkoutDir, attachedAt: '2026-08-19T12:00:00.000Z', state: 'active' },
        },
      });
      return checkoutDir;
    }

    it('GET returns the effective policy snapshot for an attached repo', async () => {
      await writeCheckoutRegistry();
      factoryd = createFactorydServer({ registryFile, port: 0 });
      await factoryd.start();

      const { status, body } = await get(factoryd.port, '/repos/on-par/software-factory/policy');
      expect(status).toBe(200);
      const parsed = JSON.parse(body);
      expect(parsed.repo).toBe('on-par/software-factory');
      expect(parsed.configPath).toMatch(/\.factory[/\\]config\.json$/);
      expect(parsed.fields).toEqual([
        expect.objectContaining({ id: 'merge.auto', value: false, source: 'default' }),
        expect.objectContaining({ id: 'merge.admin', value: false, source: 'default' }),
      ]);
    });

    it('PUT persists an allow-listed field to disk and a follow-up GET agrees', async () => {
      const checkoutDir = await writeCheckoutRegistry();
      factoryd = createFactorydServer({ registryFile, port: 0 });
      await factoryd.start();

      const putResult = await get(
        factoryd.port,
        '/repos/on-par/software-factory/policy',
        'PUT',
        JSON.stringify({ field: 'merge.auto', value: true }),
      );
      expect(putResult.status).toBe(200);
      expect(JSON.parse(putResult.body).fields).toEqual([
        expect.objectContaining({ id: 'merge.auto', value: true, source: 'config' }),
        expect.objectContaining({ id: 'merge.admin', value: false, source: 'default' }),
      ]);

      const configPath = getFactoryPaths(checkoutDir).config;
      const onDisk = JSON.parse(await readFile(configPath, 'utf-8'));
      expect(onDisk.merge.auto).toBe(true);

      const getResult = await get(factoryd.port, '/repos/on-par/software-factory/policy');
      expect(JSON.parse(getResult.body).fields).toEqual([
        expect.objectContaining({ id: 'merge.auto', value: true, source: 'config' }),
        expect.objectContaining({ id: 'merge.admin', value: false, source: 'default' }),
      ]);
    });

    it('PUT with a field outside the allow-list is rejected 400 and writes nothing', async () => {
      const checkoutDir = await writeCheckoutRegistry();
      factoryd = createFactorydServer({ registryFile, port: 0 });
      await factoryd.start();

      const { status, body } = await get(
        factoryd.port,
        '/repos/on-par/software-factory/policy',
        'PUT',
        JSON.stringify({ field: 'models.pins.build', value: true }),
      );
      expect(status).toBe(400);
      expect(JSON.parse(body).reason).toBe('invalid-field');

      const configPath = getFactoryPaths(checkoutDir).config;
      await expect(readFile(configPath, 'utf-8')).rejects.toThrow();
    });

    it('PUT with a non-boolean value is rejected 400', async () => {
      await writeCheckoutRegistry();
      factoryd = createFactorydServer({ registryFile, port: 0 });
      await factoryd.start();

      const { status, body } = await get(
        factoryd.port,
        '/repos/on-par/software-factory/policy',
        'PUT',
        JSON.stringify({ field: 'merge.auto', value: 'yes' }),
      );
      expect(status).toBe(400);
      expect(JSON.parse(body).reason).toBe('invalid-field');
    });

    it('GET returns 404 for an unattached repo', async () => {
      factoryd = createFactorydServer({ registryFile, port: 0 });
      await factoryd.start();

      const { status, body } = await get(factoryd.port, '/repos/nope/nope/policy');
      expect(status).toBe(404);
      expect(JSON.parse(body).reason).toBe('not-attached');
    });

    describe('merge.admin confirmation gate (#1390)', () => {
      it('PUT enabling merge.admin without a confirmationToken is rejected 400 and writes nothing', async () => {
        const checkoutDir = await writeCheckoutRegistry();
        const lines: string[] = [];
        factoryd = createFactorydServer({ registryFile, port: 0, log: (line) => lines.push(line) });
        await factoryd.start();

        const { status, body } = await get(
          factoryd.port,
          '/repos/on-par/software-factory/policy',
          'PUT',
          JSON.stringify({ field: 'merge.admin', value: true }),
        );
        expect(status).toBe(400);
        const parsed = JSON.parse(body);
        expect(parsed.reason).toBe('confirmation-required');
        expect(parsed.error).toContain('admin-merge bypass explicitly enabled');

        const configPath = getFactoryPaths(checkoutDir).config;
        await expect(readFile(configPath, 'utf-8')).rejects.toThrow();
        expect(lines.some((l) => l.includes('AUDIT'))).toBe(false);
      });

      it('PUT enabling merge.admin with the wrong confirmationToken is rejected 400 and writes nothing', async () => {
        const checkoutDir = await writeCheckoutRegistry();
        factoryd = createFactorydServer({ registryFile, port: 0 });
        await factoryd.start();

        const { status, body } = await get(
          factoryd.port,
          '/repos/on-par/software-factory/policy',
          'PUT',
          JSON.stringify({ field: 'merge.admin', value: true, confirmationToken: 'nope' }),
        );
        expect(status).toBe(400);
        expect(JSON.parse(body).reason).toBe('confirmation-required');

        const configPath = getFactoryPaths(checkoutDir).config;
        await expect(readFile(configPath, 'utf-8')).rejects.toThrow();
      });

      it('PUT enabling merge.admin with the matching confirmationToken writes the config and logs an AUDIT line naming the bypass', async () => {
        const checkoutDir = await writeCheckoutRegistry();
        const lines: string[] = [];
        factoryd = createFactorydServer({ registryFile, port: 0, log: (line) => lines.push(line) });
        await factoryd.start();

        const { status, body } = await get(
          factoryd.port,
          '/repos/on-par/software-factory/policy',
          'PUT',
          JSON.stringify({ field: 'merge.admin', value: true, confirmationToken: 'ENABLE_ADMIN_MERGE_BYPASS' }),
        );
        expect(status).toBe(200);
        expect(JSON.parse(body).fields).toEqual([
          expect.objectContaining({ id: 'merge.auto', value: false, source: 'default' }),
          expect.objectContaining({ id: 'merge.admin', value: true, source: 'config' }),
        ]);

        const configPath = getFactoryPaths(checkoutDir).config;
        const onDisk = JSON.parse(await readFile(configPath, 'utf-8'));
        expect(onDisk.run.merge.admin).toBe(true);

        expect(lines.some((l) => l.includes('AUDIT') && l.includes('admin-merge bypass explicitly enabled'))).toBe(
          true,
        );
      });

      it('PUT disabling merge.admin needs no confirmationToken', async () => {
        const checkoutDir = await writeCheckoutRegistry();
        const configPath = getFactoryPaths(checkoutDir).config;
        await mkdir(dirname(configPath), { recursive: true });
        await writeFile(configPath, JSON.stringify({ version: 2, run: { merge: { admin: true } } }));
        factoryd = createFactorydServer({ registryFile, port: 0 });
        await factoryd.start();

        const { status, body } = await get(
          factoryd.port,
          '/repos/on-par/software-factory/policy',
          'PUT',
          JSON.stringify({ field: 'merge.admin', value: false }),
        );
        expect(status).toBe(200);
        expect(JSON.parse(body).fields).toEqual([
          expect.objectContaining({ id: 'merge.auto', value: false, source: 'default' }),
          expect.objectContaining({ id: 'merge.admin', value: false, source: 'config' }),
        ]);
      });
    });

    it('rejects a non-GET/PUT method with 405 and an Allow: GET, PUT header', async () => {
      await writeCheckoutRegistry();
      factoryd = createFactorydServer({ registryFile, port: 0 });
      await factoryd.start();

      const { status, headers, body } = await get(factoryd.port, '/repos/on-par/software-factory/policy', 'DELETE');
      expect(status).toBe(405);
      expect(headers.allow).toBe('GET, PUT');
      expect(JSON.parse(body)).toEqual({ error: 'method not allowed' });
    });
  });

  describe('DELETE /repos/<owner>/<name>', () => {
    async function waitForState(file: string, slug: string, state: string): Promise<void> {
      for (let i = 0; i < 200; i++) {
        const loaded = await loadRegistry(file);
        if (loaded.repos[slug]?.state === state) return;
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error(`${slug} never reached state ${state}`);
    }

    it('immediately moves an active repo to draining, answers 202, and excludes it from dispatchableRepos (acceptance criterion 1)', async () => {
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
        detachDeps: { readLaneStatuses: async () => ['building'], sleep: async () => {}, pollIntervalMs: 0 },
      });
      await factoryd.start();

      const { status, body } = await get(factoryd.port, '/repos/on-par/software-factory', 'DELETE');
      expect(status).toBe(202);
      expect(JSON.parse(body)).toEqual({
        repo: {
          slug: 'on-par/software-factory',
          path: '/repos/software-factory',
          attachedAt: '2026-08-19T12:00:00.000Z',
          state: 'draining',
        },
      });

      const listing = await get(factoryd.port, '/repos');
      expect(JSON.parse(listing.body)).toEqual({
        repos: [
          {
            slug: 'on-par/software-factory',
            path: '/repos/software-factory',
            attachedAt: '2026-08-19T12:00:00.000Z',
            state: 'draining',
          },
        ],
      });
      expect(dispatchableRepos(await loadRegistry(registryFile))).toEqual([]);
    });

    it('eventually tombstones the repo once the reader clears a blocking status', async () => {
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
        detachDeps: { readLaneStatuses: async () => ['merged'], sleep: async () => {}, pollIntervalMs: 0 },
      });
      await factoryd.start();

      const { status } = await get(factoryd.port, '/repos/on-par/software-factory', 'DELETE');
      expect(status).toBe(202);

      await waitForState(registryFile, 'on-par/software-factory', 'detached');
    });

    it('?force=true tombstones immediately, answers 200, and never calls readLaneStatuses (acceptance criterion 2)', async () => {
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
      });
    });

    it.each(['?force=false', '?force=1', '?force=yes', ''])('takes the drain path for %s', async (query) => {
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
        detachDeps: { readLaneStatuses: async () => ['building'], sleep: async () => {}, pollIntervalMs: 0 },
      });
      await factoryd.start();

      const { status, body } = await get(factoryd.port, `/repos/on-par/software-factory${query}`, 'DELETE');
      expect(status).toBe(202);
      expect(JSON.parse(body).repo.state).toBe('draining');
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
      expect(JSON.parse(body).repo.state).toBe('detached');
    });

    it('returns 404 unknown-repo for a slug not in the registry', async () => {
      factoryd = createFactorydServer({ registryFile, port: 0 });
      await factoryd.start();

      const { status, body } = await get(factoryd.port, '/repos/on-par/nope', 'DELETE');
      expect(status).toBe(404);
      expect(JSON.parse(body)).toEqual({ error: 'on-par/nope is not attached', reason: 'unknown-repo' });
    });

    it('is idempotent for an already-detached slug and answers 200', async () => {
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

      const { status, body } = await get(factoryd.port, '/repos/on-par/software-factory', 'DELETE');
      expect(status).toBe(200);
      expect(JSON.parse(body).repo.state).toBe('detached');
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

      expect((await get(factoryd.port, '/repos/on-par/x/', 'DELETE')).status).toBe(202);
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
      expect(lines).toEqual(['DELETE /repos/on-par/software-factory 202']);
    });

    it('stop() resolves while a drain is pending, aborting it and leaving the entry draining', async () => {
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
        detachDeps: { readLaneStatuses: async () => ['building'], sleep: async () => {}, pollIntervalMs: 0 },
      });
      await factoryd.start();

      const { status } = await get(factoryd.port, '/repos/on-par/software-factory', 'DELETE');
      expect(status).toBe(202);

      await factoryd.stop();
      factoryd = undefined;

      expect((await loadRegistry(registryFile)).repos['on-par/software-factory']?.state).toBe('draining');
    });
  });

  describe('runs', () => {
    async function activeRepo(): Promise<void> {
      await writeRegistry(registryFile, {
        version: 1,
        repos: { 'owner/example-app': { path: '/repos/example-app', attachedAt: 't', state: 'active' } },
      });
    }

    it('submits an idempotent run and exposes its persisted terminal record', async () => {
      await activeRepo();
      let calls = 0;
      factoryd = createFactorydServer({
        registryFile,
        port: 0,
        runExecutor: async () => {
          calls++;
        },
      });
      await factoryd.start();
      const body = JSON.stringify({ runId: 'R', repo: 'owner/example-app', issue: 7 });
      const first = await get(factoryd.port, '/runs', 'POST', body);
      const replay = await get(factoryd.port, '/runs', 'POST', body);
      expect(first.status).toBe(201);
      expect(replay.status).toBe(200);
      const firstRun = JSON.parse(first.body).run;
      const replayRun = JSON.parse(replay.body).run;
      expect(replayRun).toMatchObject({
        runId: firstRun.runId,
        repo: firstRun.repo,
        issue: firstRun.issue,
        submittedAt: firstRun.submittedAt,
      });
      await factoryd.stop();
      factoryd = undefined;
      expect(calls).toBe(1);
      const reader = createFactorydServer({ registryFile, port: 0 });
      await reader.start();
      const current = await get(reader.port, '/runs/R');
      const terminalReplay = await get(reader.port, '/runs', 'POST', body);
      await reader.stop();
      expect(JSON.parse(current.body).run.status).toBe('succeeded');
      expect(JSON.parse(terminalReplay.body).run).toEqual(JSON.parse(current.body).run);
    });

    it('guards run methods, malformed ids, request bodies, and registry dispatchability', async () => {
      factoryd = createFactorydServer({ registryFile, port: 0 });
      await factoryd.start();
      expect((await get(factoryd.port, '/runs', 'DELETE')).headers.allow).toBe('POST');
      expect((await get(factoryd.port, '/runs/R', 'POST')).headers.allow).toBe('GET');
      expect(JSON.parse((await get(factoryd.port, '/runs/..%2Fetc')).body).reason).toBe('unknown-run');
      expect((await get(factoryd.port, '/runs', 'POST', 'not json')).status).toBe(400);
      expect(
        (await get(factoryd.port, '/runs', 'POST', JSON.stringify({ runId: 'R', repo: 'none/x', issue: 1 }))).status,
      ).toBe(404);
      await activeRepo();
      await writeRegistry(registryFile, {
        version: 1,
        repos: { 'owner/example-app': { path: '/x', attachedAt: 't', state: 'paused' } },
      });
      expect(
        (await get(factoryd.port, '/runs', 'POST', JSON.stringify({ runId: 'R', repo: 'owner/example-app', issue: 1 })))
          .status,
      ).toBe(409);
    });
  });
});
