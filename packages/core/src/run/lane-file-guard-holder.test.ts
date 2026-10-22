// packages/core/src/run/lane-file-guard-holder.test.ts — a claim left by a crashed run is reaped (#1618)

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Octokit } from '@octokit/rest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import { createGithubLaneClaimStalenessProbe, LaneFileGuard } from './lane-file-guard.js';

const tempDirs = createTempDirs();

afterEach(() => tempDirs.cleanup());

async function tmpFile(): Promise<string> {
  const dir = await tempDirs.make('lane-file-guard-holder-test-');
  return join(dir, 'lane-files.json');
}

describe('LaneFileGuard holder-not-running', () => {
  type Issue = { state: string; labels: string[]; title: string };

  async function setup(issue: Issue, isPidAlive?: (pid: number) => boolean, seedClaim?: Record<string, unknown>) {
    const file = await tmpFile();
    const guard = new LaneFileGuard(file);
    const claim = {
      repo: 'acme/repo',
      issue: 1,
      files: ['a.swift'],
      claimedAt: '2026-10-18T06:53:00.000Z',
      ...seedClaim,
    };
    await writeFile(file, JSON.stringify({ version: 1, claims: { [`acme/repo#${claim.issue}`]: claim } }));
    const get = vi.fn(async () => ({ data: issue }));
    const list = vi.fn(async () => ({ data: [] }));
    const octokit: Pick<Octokit, 'rest'> = Object.assign({} as Octokit, { rest: { issues: { get }, pulls: { list } } });
    const events: Array<[string, string]> = [];
    const log = (type: string, msg: string) => events.push([type, msg]);
    const probe = createGithubLaneClaimStalenessProbe({ octokit, branchPrefix: 'factory', isPidAlive });
    const check = () => guard.findCollision('acme/repo', 2, ['a.swift'], { isStale: probe, log });
    return { file, guard, events, log, probe, check };
  }

  const open: Issue = { state: 'open', labels: [], title: 'Do thing' };

  it("a crash-left claim for a queued issue doesn't hold another issue", async () => {
    const { guard, events, check } = await setup(
      { state: 'open', labels: ['factory:queued'], title: 'Status report' },
      () => false,
      { issue: 247, pid: 999999 },
    );
    await expect(check()).resolves.toBeUndefined();
    expect(await guard.claimsForIssue(247)).toEqual([]);
    expect(events).toHaveLength(1);
    expect(events[0][0]).toBe('lane_file_claim_reaped');
    expect(events[0][1]).toContain('#247');
    expect(events[0][1]).toContain('holder-not-running');
  });

  it('reaps a no-PR, not-in-progress claim with no pid field (older claim)', async () => {
    const isPidAlive = vi.fn(() => true);
    const { guard, events, check } = await setup(open, isPidAlive, {});
    await expect(check()).resolves.toBeUndefined();
    expect(await guard.claimsForIssue(1)).toEqual([]);
    expect(events[0][1]).toContain('holder-not-running');
    expect(isPidAlive).not.toHaveBeenCalled();
  });

  it.each([0, -1])('reaps a claim with malformed pid %i without probing it', async (pid) => {
    const isPidAlive = vi.fn(() => true);
    const { guard, events, check } = await setup(open, isPidAlive, {
      pid,
    });
    await expect(check()).resolves.toBeUndefined();
    expect(await guard.claimsForIssue(1)).toEqual([]);
    expect(events[0][1]).toContain('holder-not-running');
    expect(isPidAlive).not.toHaveBeenCalled();
  });

  it('keeps a PR-less, not-in-progress claim whose recorded pid is alive', async () => {
    const isPidAlive = vi.fn(() => true);
    const { guard, events, check } = await setup(open, isPidAlive, {
      pid: 4242,
    });
    await expect(check()).resolves.toEqual({ issue: 1, file: 'a.swift' });
    expect(await guard.claimsForIssue(1)).toHaveLength(1);
    expect(isPidAlive).toHaveBeenCalledWith(4242);
    expect(events).toEqual([]);
  });

  it('keeps a claim with a dead pid and no PR when the holder is factory:in-progress or carries a live lease', async () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    for (const labels of [['factory:in-progress'], [`factory:claim-expires:${future}`]]) {
      const isPidAlive = vi.fn(() => false);
      const { guard, check } = await setup({ state: 'open', labels, title: 'Do thing' }, isPidAlive, {
        pid: 4242,
      });
      await expect(check()).resolves.toEqual({ issue: 1, file: 'a.swift' });
      expect(await guard.claimsForIssue(1)).toHaveLength(1);
      expect(isPidAlive).not.toHaveBeenCalled();
    }
  });

  it('reaps a no-PR claim whose holder is factory:in-progress with an expired lease (#3442)', async () => {
    const past = Math.floor(Date.now() / 1000) - 3600;
    const { guard, events, check } = await setup(
      { state: 'open', labels: ['factory:in-progress', `factory:claim-expires:${past}`], title: 'Do thing' },
      () => false,
      { pid: 4242 },
    );
    await expect(check()).resolves.toBeUndefined();
    expect(await guard.claimsForIssue(1)).toEqual([]);
    expect(events[0][1]).toContain('holder-not-running');
  });

  it('keeps the claim when isPidAlive throws', async () => {
    const { guard, check } = await setup(
      open,
      () => {
        throw new Error('EPERM');
      },
      { pid: 4242 },
    );
    await expect(check()).resolves.toEqual({ issue: 1, file: 'a.swift' });
    expect(await guard.claimsForIssue(1)).toHaveLength(1);
  });

  it('sweepStale reaps a crash-left claim (holder-not-running)', async () => {
    const { guard, events, log, probe } = await setup(
      { state: 'open', labels: ['factory:queued'], title: 'X' },
      () => false,
    );
    const reaped = await guard.sweepStale({ isStale: probe, log });
    expect(reaped).toHaveLength(1);
    expect(reaped[0]).toMatchObject({ claim: { issue: 1 }, reason: 'holder-not-running' });
    expect(await guard.claimsForIssue(1)).toEqual([]);
    expect(events[0][1]).toContain('holder-not-running');
  });
});
