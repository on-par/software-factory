import { writeFile } from 'node:fs/promises';
import http from 'node:http';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import { createFactorydServer, type FactorydServer } from './factoryd-http.js';

function post(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolvePromise, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'POST' }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolvePromise({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('POST /repos/<owner>/<name>/pause|resume', () => {
  const tempDirs = createTempDirs();
  let dir: string;
  let registryFile: string;
  let factoryd: FactorydServer | undefined;

  beforeEach(async () => {
    dir = await tempDirs.make('factoryd-http-repo-status-');
    registryFile = join(dir, 'registry.json');
  });

  afterEach(async () => {
    await factoryd?.stop();
    factoryd = undefined;
    await tempDirs.cleanup();
  });

  it('answers 409 with reason draining for pause and resume on a draining repo', async () => {
    const entry = { path: '/repos/software-factory', attachedAt: '2026-08-19T12:00:00.000Z', state: 'draining' };
    await writeFile(registryFile, JSON.stringify({ version: 1, repos: { 'on-par/software-factory': entry } }));
    factoryd = createFactorydServer({ registryFile, port: 0 });
    await factoryd.start();

    for (const action of ['pause', 'resume']) {
      const { status, body } = await post(factoryd.port, `/repos/on-par/software-factory/${action}`);
      expect(status).toBe(409);
      expect(JSON.parse(body).reason).toBe('draining');
    }
  });
});
