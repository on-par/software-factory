// packages/cli/src/cli/run-brief.test.ts — run-brief rejects a bad --base-branch before resolving any brief (#3764)
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { errored, h, installShipHarness, phases, runMainWith } from './test-support/ship-harness.js';

installShipHarness();

const runMain = (...args: string[]) => runMainWith(undefined, ...args);

function brief(): string {
  const path = join(h.repoRoot, 'alpha.md');
  writeFileSync(path, '# Add alpha\n\nPlease add alpha.\n\n## Acceptance criteria\n\n- alpha exists\n');
  return path;
}

describe('run-brief --base-branch (#3764)', () => {
  it('rejects a -prefixed --base-branch before resolving any brief', async () => {
    const res = await runMain('run-brief', brief(), '--base-branch=-x');
    expect(res).toEqual({ exited: true, code: 2 });
    expect(errored()).toContain("invalid --base-branch '-x'");
    expect(phases.planPhase).not.toHaveBeenCalled();
  });

  it('rejects --base-branch with --workspace', async () => {
    const res = await runMain('run-brief', brief(), '--base-branch', 'feat/x', '--workspace', h.repoRoot);
    expect(res).toEqual({ exited: true, code: 2 });
    expect(errored()).toContain('--base-branch needs a factory worktree');
    expect(phases.planPhase).not.toHaveBeenCalled();
  });

  it('starts the brief run from origin/<ref>', async () => {
    const res = await runMain('run-brief', brief(), '--base-branch', 'feat/x');
    expect(res.exited).toBe(false);
    expect((phases.shipPhase.mock.calls[0][0] as any).baseBranch).toBe('feat/x');
  });
});
