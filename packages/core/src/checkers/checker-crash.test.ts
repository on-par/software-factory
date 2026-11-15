import { afterEach, describe, expect, it } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import type { ModelRouter } from '../router/index.js';
import { runAllCheckers } from './index.js';
import { probeWorktree, type WorktreeProbe } from './probe.js';

const tempDirs = createTempDirs();

afterEach(() => tempDirs.cleanup());

describe('runAllCheckers with a crashing checker', () => {
  it('keeps a checker that throws in the summary as a FAIL', async () => {
    const worktree = await tempDirs.make('checker-crash-');
    const probe: WorktreeProbe = {
      ...(await probeWorktree(worktree)),
      get htmlFiles(): never {
        throw new Error('probe exploded');
      },
    };

    const summary = await runAllCheckers(
      { worktree, specPath: '', env: {}, probe },
      {} as ModelRouter,
      null,
      undefined,
      ['links'],
    );

    expect(summary.results).toEqual([{ checker: 'links', result: 'FAIL', details: 'checker crashed: probe exploded' }]);
    expect(summary.failures).toBe(1);
  });
});
