import { afterEach, describe, expect, it } from 'vitest';

import { createServer, type FactoryServer } from './index.js';

describe('createServer pause failures', () => {
  let server: FactoryServer | undefined;

  afterEach(async () => {
    await server?.stop();
    server = undefined;
  });

  it('answers 500 when the lane controller pause rejects', async () => {
    server = createServer({
      repositories: [
        {
          repo: 'owner/app',
          source: { on: () => () => {} },
          controller: { pause: () => Promise.reject(new Error('boom')) },
        },
      ],
      port: 0,
    });
    await server.start();

    const res = await fetch(`http://127.0.0.1:${server.port}/repos/owner/app/lanes/lane-1/pause`, { method: 'POST' });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal error' });
  });
});
