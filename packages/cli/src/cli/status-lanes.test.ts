// packages/cli/src/cli/status-lanes.test.ts — the `factory status` Lanes section (#3958).

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { installShipHarness, logged, paths, runMainWith } from './test-support/ship-harness.js';

installShipHarness();

describe('factory status Lanes section (#3958)', () => {
  it('shows running lanes against the cap and the waiting lanes of the active run', async () => {
    const file = join(paths().state, 'lane-slots.json');
    mkdirSync(paths().state, { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        maxLanes: 1,
        source: 'flag',
        running: ['app'],
        waiting: ['docs'],
        updatedAt: '2026-11-05T00:00:00.000Z',
        pid: 1,
      }),
    );
    await runMainWith(undefined, 'status');
    const out = logged();
    expect(out).toContain('== Lanes ==');
    expect(out).toContain('lanes 1/1 running');
    expect(out).toContain('waiting for a slot: docs');
  });

  it('says no run is active without a lane-slots file', async () => {
    await runMainWith(undefined, 'status');
    expect(logged()).toContain('(no factory run active)');
  });
});
