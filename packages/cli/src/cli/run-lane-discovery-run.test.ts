// packages/cli/src/cli/run-lane-discovery-run.test.ts — factory run ships work queued after it started (#3920)

import { writeFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { h, installShipHarness, paths, runMainWith } from './test-support/ship-harness.js';

installShipHarness();

describe('factory run lane discovery (#3920)', () => {
  it('ships a lane line appended to the local queue while the first lane is running', async () => {
    writeFileSync(paths().queue, '# header\napp 5\n');
    const branches: string[] = [];
    h.setupWorktreeImpl = async (_r, branch) => {
      branches.push(branch);
      if (branches.length === 1) writeFileSync(paths().queue, '# header\napp 5\nlate 9\n');
    };
    const res = await runMainWith(undefined, 'run', '--local-queue');
    expect(res.exited).toBe(false);
    expect(branches).toHaveLength(2);
    expect(branches[1]).toMatch(/^factory\/9-/);
  });
});
