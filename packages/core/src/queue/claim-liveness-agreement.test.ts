// packages/core/src/queue/claim-liveness-agreement.test.ts — the reaper, worktree GC and the lane-file guard agree (#3442)

import type { Octokit } from '@octokit/rest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createGithubLaneClaimStalenessProbe } from '../run/lane-file-guard.js';
import { claimOf } from '../worktree/worktree-gc-issues.js';
import { findStaleClaims } from './stale-claims.js';

const NOW = 1_800_000_000_000;
const nowS = NOW / 1000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

async function verdicts(labels: string[]) {
  const reaper = findStaleClaims([{ number: 1, labels }], { now: () => NOW }).length === 0;
  const gc = claimOf({ kind: 'ok', state: 'open', labels }, 1) === 'claimed';
  const get = vi.fn(async () => ({ data: { state: 'open', labels, title: 'X' } }));
  const list = vi.fn(async () => ({ data: [] }));
  const octokit: Pick<Octokit, 'rest'> = Object.assign({} as Octokit, { rest: { issues: { get }, pulls: { list } } });
  const probe = createGithubLaneClaimStalenessProbe({ octokit, now: () => NOW, isPidAlive: () => false });
  const guard = (await probe({ repo: 'acme/repo', issue: 1, files: ['a'], claimedAt: '', pid: 4242 })) === undefined;
  return { reaper, gc, guard };
}

describe('claim liveness agreement', () => {
  it('in-progress with an expired lease is not live to the reaper, worktree GC or the lane-file guard', async () => {
    const labels = ['factory:in-progress', 'factory:claimed-by:x', `factory:claim-expires:${nowS - 60}`];
    expect(await verdicts(labels)).toEqual({ reaper: false, gc: false, guard: false });
  });

  it.each([[[`factory:claim-expires:${nowS + 60}`]], [['factory:claimed-by:x', `factory:claim-expires:${nowS + 60}`]]])(
    'a live lease is live to the reaper, worktree GC and the lane-file guard',
    async (labels) => {
      expect(await verdicts(labels)).toEqual({ reaper: true, gc: true, guard: true });
    },
  );

  it('claimed-by with no lease is live to the reaper, worktree GC and the lane-file guard', async () => {
    expect(await verdicts(['factory:claimed-by:x'])).toEqual({ reaper: true, gc: true, guard: true });
  });
});
