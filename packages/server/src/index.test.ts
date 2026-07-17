import { describe, expect, it } from 'vitest';

import { createServer, SERVER_VERSION } from './index.js';

describe('@on-par/factory-server stub', () => {
  it('exports a semver-shaped SERVER_VERSION', () => {
    expect(SERVER_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('createServer throws the not-implemented error', () => {
    expect(() =>
      createServer({
        port: 3000,
        webhookSecret: 'secret',
        sandboxProvider: 'docker',
        autoMerge: false,
      }),
    ).toThrow(/not yet implemented/i);
  });
});
