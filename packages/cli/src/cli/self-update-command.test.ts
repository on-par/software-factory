import { describe, expect, it } from 'vitest';

import { installCliCommandsHarness, runMain, runMainWith } from './test-support/cli-commands-harness.js';

installCliCommandsHarness();

describe('self-update', () => {
  const install = {
    version: '0.9.0',
    env: {},
    execPath: '/usr/local/bin/node',
    cliPath: '/usr/local/lib/node_modules/@on-par/factory-cli/dist/cli.js',
    exists: () => false,
  };

  it('--check --json prints the result and exits 10 when an update is available', async () => {
    const out: string[] = [];
    const res = await runMainWith(
      {
        selfUpdate: {
          fetch: async () => ({ status: 200, body: '{"latest":"0.9.1"}' }),
          install,
          out: { write: (s: string) => out.push(s) },
        },
      },
      'self-update',
      '--check',
      '--json',
    );
    expect(res.code).toBe(10);
    expect(JSON.parse(out.join(''))).toMatchObject({ updateAvailable: true, candidate: '0.9.1' });
  });

  it('exits 2 without --check', async () => {
    const res = await runMain('self-update');
    expect(res.code).toBe(2);
  });
});
