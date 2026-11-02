// packages/cli/src/cli/ship.base-branch.test.ts — --base-branch starts the worktree from origin/<ref> and sets parentBaseRef (#3764)
import { describe, expect, it } from 'vitest';

import { h, installShipHarness, phases, setupWorktree, shipIssue } from './test-support/ship-harness.js';

installShipHarness();

describe('shipIssue --base-branch (#3764)', () => {
  const ctx = () => ({ repoRoot: h.repoRoot, ghRepo: h.ghRepo });

  it('creates the worktree from origin/<ref> when --base-branch is set', async () => {
    await shipIssue(5, { baseBranch: 'feat/x' }, ctx());
    expect(setupWorktree.mock.calls[0]?.[3]).toBe('origin/feat/x');
  });

  it('creates the worktree from the default base when --base-branch is omitted', async () => {
    await shipIssue(5, {}, ctx());
    expect(setupWorktree.mock.calls[0]?.[3]).toBeUndefined();
  });

  it('passes origin/<ref> to runIssue as parentBaseRef', async () => {
    await shipIssue(5, { baseBranch: 'feat/x', sizeGate: undefined }, ctx());
    expect(phases.checkBaseHealth.mock.calls[0][0]).toMatchObject({ baseRef: 'origin/feat/x' });
    expect((phases.checkPhase.mock.calls[0][0] as any).parentBaseRef).toBe('origin/feat/x');
    expect((phases.shipPhase.mock.calls[0][0] as any).baseBranch).toBe('feat/x');
  });
});
