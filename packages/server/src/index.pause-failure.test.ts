import http from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import { createServer, type FactoryServer, type LaneController } from './index.js';

const REPO = 'owner/example-app';

function request(port: number, path: string, method = 'GET'): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('@on-par/factory-server request failures', () => {
  let server: FactoryServer | undefined;

  afterEach(async () => {
    await server?.stop();
    server = undefined;
  });

  it("answers 500 and keeps serving when the lane controller's pause rejects", async () => {
    const controller: LaneController = { pause: () => Promise.reject(new Error('boom')) };
    server = createServer({
      repositories: [{ repo: REPO, source: { on: () => () => undefined }, controller }],
      port: 0,
    });
    await server.start();

    const paused = await request(server.port, `/repos/${REPO}/lanes/lane-1/pause`, 'POST');

    expect(paused.status).toBe(500);
    expect(paused.body).toBe(JSON.stringify({ error: 'internal error' }));
    expect((await request(server.port, '/nope')).status).toBe(404);
  });
});
