import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createFactorydServer, type FactorydServer } from './factoryd-http.js';

function get(port: number, path: string, method: string, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolvePromise, reject) => {
    const headers = { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) };
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let responseBody = '';
      res.on('data', (chunk) => (responseBody += chunk));
      res.on('end', () => resolvePromise({ status: res.statusCode ?? 0, body: responseBody }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

describe('POST /repos re-attaching a registered slug (#3200)', () => {
  let dir: string;
  let registryFile: string;
  let factoryd: FactorydServer | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'factoryd-reattach-'));
    registryFile = join(dir, 'registry.json');
  });

  afterEach(async () => {
    await factoryd?.stop();
    factoryd = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  const slug = 'on-par/software-factory';
  const attachedAt = '2020-01-01T00:00:00.000Z';

  async function start(entry: Record<string, unknown>, lines: string[] = []): Promise<string> {
    await writeFile(registryFile, JSON.stringify({ version: 1, repos: { [slug]: entry } }, null, 2));
    const before = await readFile(registryFile, 'utf-8');
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
    return before;
  }

  function post(port: number, extra: Record<string, unknown> = {}) {
    return get(port, '/repos', 'POST', JSON.stringify({ repo: slug, path: '/tmp/checkout', ...extra }));
  }

  it('re-attaching a paused entry at the same path returns 200 created false changed false and leaves registry.json byte-identical', async () => {
    const lines: string[] = [];
    const before = await start({ path: '/tmp/checkout', attachedAt, state: 'paused' }, lines);
    const { status, body } = await post(factoryd?.port ?? 0);
    expect(status).toBe(200);
    expect(JSON.parse(body)).toEqual({
      repo: { slug, path: '/tmp/checkout', attachedAt, state: 'paused' },
      created: false,
      changed: false,
    });
    expect(await readFile(registryFile, 'utf-8')).toBe(before);
    expect(lines).toEqual(['POST /repos 200']);
  });

  it('re-attaching a paused entry at a new path returns 200 changed true', async () => {
    await start({ path: '/tmp/old', attachedAt, state: 'paused' });
    const { status, body } = await post(factoryd?.port ?? 0);
    expect(status).toBe(200);
    expect(JSON.parse(body)).toEqual({
      repo: { slug, path: '/tmp/checkout', attachedAt, state: 'paused' },
      created: false,
      changed: true,
    });
  });

  it('answers 409 draining and leaves registry.json byte-identical', async () => {
    const before = await start({ path: '/tmp/checkout', attachedAt, state: 'draining' });
    const { status, body } = await post(factoryd?.port ?? 0);
    expect(status).toBe(409);
    expect(JSON.parse(body)).toEqual({ error: expect.any(String), reason: 'draining' });
    expect(await readFile(registryFile, 'utf-8')).toBe(before);
  });

  it('answers 409 state-root-mismatch and leaves registry.json byte-identical', async () => {
    const before = await start({ path: '/tmp/checkout', stateRoot: '/ext/root', attachedAt, state: 'active' });
    const { status, body } = await post(factoryd?.port ?? 0, { stateRoot: '/other/root' });
    expect(status).toBe(409);
    expect(JSON.parse(body)).toEqual({ error: expect.any(String), reason: 'state-root-mismatch' });
    expect(await readFile(registryFile, 'utf-8')).toBe(before);
  });

  it('reviving a detached tombstone returns 201 created true with state active and a new attachedAt', async () => {
    await start({ path: '/tmp/checkout', attachedAt, state: 'detached' });
    const { status, body } = await post(factoryd?.port ?? 0);
    expect(status).toBe(201);
    expect(JSON.parse(body)).toEqual({
      repo: { slug, path: '/tmp/checkout', attachedAt: '2026-08-19T12:00:00.000Z', state: 'active' },
      created: true,
    });
  });
});
