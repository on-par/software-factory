// packages/cli/src/cli/run-lane-discovery-run.test.ts — factory run ships work queued after it started (#3920)

import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

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

  it('passes --max-lanes to the supervisor, writes lane-slots.json while running and clears it at the end (#3958)', async () => {
    writeFileSync(paths().queue, '# header\napp 5\ndocs 6\n');
    const seen: unknown[] = [];
    h.setupWorktreeImpl = async () => {
      seen.push(JSON.parse(readFileSync(join(paths().state, 'lane-slots.json'), 'utf-8')));
    };
    const res = await runMainWith(undefined, 'run', '--local-queue', '--max-lanes', '1');
    expect(res.exited).toBe(false);
    expect(seen[0]).toMatchObject({ maxLanes: 1, source: 'flag', running: ['app'], waiting: ['docs'] });
    expect(seen).toHaveLength(2);
    expect(existsSync(join(paths().state, 'lane-slots.json'))).toBe(false);
  });

  it('rejects an invalid --max-lanes with exit 2 (#3958)', async () => {
    const res = await runMainWith(undefined, 'run', '--local-queue', '--max-lanes', '0');
    expect(res).toMatchObject({ exited: true, code: 2 });
  });
});
