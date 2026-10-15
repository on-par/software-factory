// packages/cli/src/cli/worktree-reap.test.ts — formatShipReapLine run-output lines (#3009)
import { describe, expect, it } from 'vitest';

import { formatShipReapLine } from './worktree-reap.js';

const WT = '/wt/5';
const BR = 'factory/5-fix';

describe('formatShipReapLine', () => {
  it('reports the removal with the deleted branch', () => {
    const line = formatShipReapLine(WT, { outcome: 'removed', branch: BR, branchDeleted: true });
    expect(line).toBe(`🧹 Removed worktree ${WT} and branch ${BR} — no PR was opened and nothing was committed`);
  });

  it('omits the branch when it was not deleted', () => {
    const line = formatShipReapLine(WT, { outcome: 'removed', branch: BR, branchDeleted: false });
    expect(line).toBe(`🧹 Removed worktree ${WT} — no PR was opened and nothing was committed`);
  });

  it('explains a dirty keep', () => {
    const line = formatShipReapLine(WT, { outcome: 'kept-dirty', branch: BR, branchDeleted: false });
    expect(line).toContain(WT);
    expect(line).toContain(BR);
    expect(line).toContain('uncommitted changes');
  });

  it('explains a committed keep', () => {
    const line = formatShipReapLine(WT, { outcome: 'kept-committed', branch: BR, branchDeleted: false });
    expect(line).toContain(WT);
    expect(line).toContain('commits beyond the base');
  });

  it('names the non-lane branch', () => {
    const line = formatShipReapLine(WT, { outcome: 'kept-branch-mismatch', branch: 'main', branchDeleted: false });
    expect(line).toContain(WT);
    expect(line).toContain("'main'");
  });

  it('reports unverified state for kept-unverified and for a thrown reap', () => {
    const unverified = formatShipReapLine(WT, { outcome: 'kept-unverified', branch: null, branchDeleted: false });
    expect(unverified).toContain(WT);
    expect(unverified).toContain('could not be verified');
    expect(formatShipReapLine(WT, undefined)).toBe(unverified);
  });

  it('prints nothing for an absent worktree', () => {
    expect(formatShipReapLine(WT, { outcome: 'absent', branch: null, branchDeleted: false })).toBeNull();
  });
});
