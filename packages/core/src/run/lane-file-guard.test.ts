import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Octokit } from '@octokit/rest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DesignArtifact } from '../types/index.js';
import {
  createGithubLaneClaimStalenessProbe,
  LaneFileGuard,
  releaseLaneClaim,
  touchedFilesFrom,
} from './lane-file-guard.js';

const tempDirs = new Set<string>();

afterEach(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
  tempDirs.clear();
});

async function tmpFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'lane-file-guard-test-'));
  tempDirs.add(dir);
  return join(dir, 'lane-files.json');
}

function baseDesign(overrides: Partial<Pick<DesignArtifact, 'targetTypes' | 'signatures'>> = {}) {
  return {
    targetTypes: [],
    signatures: [],
    ...overrides,
  };
}

describe('touchedFilesFrom', () => {
  it('dedups repeated files across targetTypes and signatures', () => {
    const files = touchedFilesFrom(
      baseDesign({
        targetTypes: [{ name: 'Foo', file: 'src/a.ts', kind: 'changed' }],
        signatures: [{ symbol: 'foo', file: 'src/a.ts', signature: '() => void' }],
      }),
    );
    expect(files).toEqual(['src/a.ts']);
  });

  it('excludes a targetTypes entry with kind: read', () => {
    const files = touchedFilesFrom(
      baseDesign({
        targetTypes: [{ name: 'Foo', file: 'src/read-only.ts', kind: 'read' }],
      }),
    );
    expect(files).toEqual([]);
  });

  it('includes targetTypes entries with kind changed or added', () => {
    const files = touchedFilesFrom(
      baseDesign({
        targetTypes: [
          { name: 'Foo', file: 'src/changed.ts', kind: 'changed' },
          { name: 'Bar', file: 'src/added.ts', kind: 'added' },
        ],
      }),
    );
    expect(files.sort()).toEqual(['src/added.ts', 'src/changed.ts']);
  });

  it('includes every signatures entry regardless of kind (signatures has no kind field)', () => {
    const files = touchedFilesFrom(
      baseDesign({
        signatures: [{ symbol: 'foo', file: 'src/sig.ts', signature: '() => void' }],
      }),
    );
    expect(files).toEqual(['src/sig.ts']);
  });
});

describe('LaneFileGuard', () => {
  it('findCollision returns the colliding issue+file when another repo-scoped claim overlaps', async () => {
    const file = await tmpFile();
    const guard = new LaneFileGuard(file);

    await guard.register('acme/repo', 100, ['src/shared.ts']);
    const collision = await guard.findCollision('acme/repo', 200, ['src/shared.ts', 'src/other.ts']);

    expect(collision).toEqual({ issue: 100, file: 'src/shared.ts' });
  });

  it('findCollision returns undefined for a disjoint file set', async () => {
    const file = await tmpFile();
    const guard = new LaneFileGuard(file);

    await guard.register('acme/repo', 100, ['src/shared.ts']);
    const collision = await guard.findCollision('acme/repo', 200, ['src/unrelated.ts']);

    expect(collision).toBeUndefined();
  });

  it('findCollision excludes the same repo+issue that registered the claim', async () => {
    const file = await tmpFile();
    const guard = new LaneFileGuard(file);

    await guard.register('acme/repo', 100, ['src/shared.ts']);
    const collision = await guard.findCollision('acme/repo', 100, ['src/shared.ts']);

    expect(collision).toBeUndefined();
  });

  it('findCollision is scoped to a single repo — an overlapping file in a different repo does not collide', async () => {
    const file = await tmpFile();
    const guard = new LaneFileGuard(file);

    await guard.register('acme/repo-a', 100, ['src/shared.ts']);
    const collision = await guard.findCollision('acme/repo-b', 200, ['src/shared.ts']);

    expect(collision).toBeUndefined();
  });

  it('register is a no-op for an empty file set', async () => {
    const file = await tmpFile();
    const guard = new LaneFileGuard(file);

    await guard.register('acme/repo', 100, []);
    const collision = await guard.findCollision('acme/repo', 200, []);

    expect(collision).toBeUndefined();
  });

  it('release makes a previously-claimed path claimable again', async () => {
    const file = await tmpFile();
    const guard = new LaneFileGuard(file);

    await guard.register('acme/repo', 100, ['src/shared.ts']);
    await guard.release('acme/repo', 100);
    const collision = await guard.findCollision('acme/repo', 200, ['src/shared.ts']);

    expect(collision).toBeUndefined();
  });

  it('release on a repo+issue with no claim is a no-op that does not throw', async () => {
    const file = await tmpFile();
    const guard = new LaneFileGuard(file);

    await expect(guard.release('acme/repo', 999)).resolves.toBeUndefined();
  });

  it('releaseIssue removes the issue claims across repos and leaves others alone', async () => {
    const guard = new LaneFileGuard(await tmpFile());
    await guard.register('acme/repo', 100, ['src/a.ts']);
    await guard.register('other/repo', 100, ['src/b.ts']);
    await guard.register('acme/repo', 200, ['src/a.ts']);

    await expect(guard.releaseIssue(100)).resolves.toBe(true);

    expect(await guard.findCollision('acme/repo', 300, ['src/b.ts'])).toBeUndefined();
    expect(await guard.findCollision('acme/repo', 300, ['src/a.ts'])).toEqual({ issue: 200, file: 'src/a.ts' });
  });

  it('claimsForIssue returns the issue claims across repos without changing the file', async () => {
    const file = await tmpFile();
    const guard = new LaneFileGuard(file);
    await guard.register('acme/repo', 100, ['src/a.ts']);
    await guard.register('other/repo', 100, ['src/b.ts']);
    await guard.register('acme/repo', 200, ['src/a.ts']);
    const before = await readFile(file, 'utf-8');

    const claims = await guard.claimsForIssue(100);

    expect(claims.map((c) => c.repo).sort()).toEqual(['acme/repo', 'other/repo']);
    expect(await guard.claimsForIssue(999)).toEqual([]);
    expect(await readFile(file, 'utf-8')).toBe(before);
  });

  it('releaseIssue resolves false when the issue has no claim', async () => {
    const guard = new LaneFileGuard(await tmpFile());
    await expect(guard.releaseIssue(999)).resolves.toBe(false);
  });
});

describe('LaneFileGuard stale claims', () => {
  type Issue = { state: string; labels: Array<string | { name: string }>; title: string };
  type Pr = { state: string; merged_at: string | null };

  async function setup(issue: Issue | Error, prs: Pr[] = []) {
    const file = await tmpFile();
    const guard = new LaneFileGuard(file);
    await guard.register('acme/repo', 1, ['a.swift']);
    const get = vi.fn(async () => {
      if (issue instanceof Error) throw issue;
      return { data: issue };
    });
    const list = vi.fn(async () => ({ data: prs }));
    const octokit: Pick<Octokit, 'rest'> = Object.assign({} as Octokit, { rest: { issues: { get }, pulls: { list } } });
    const events: Array<[string, string]> = [];
    const log = (type: string, msg: string) => events.push([type, msg]);
    const check = (now?: () => number) =>
      guard.findCollision('acme/repo', 2, ['a.swift'], {
        isStale: createGithubLaneClaimStalenessProbe({ octokit, branchPrefix: 'factory', now }),
        log,
      });
    return { file, guard, list, events, check };
  }

  it('reaps a claim whose holder issue is closed and emits lane_file_claim_reaped (issue-closed)', async () => {
    const { guard, list, events, check } = await setup({ state: 'closed', labels: [], title: 'X' });
    await expect(check()).resolves.toBeUndefined();
    expect(await guard.claimsForIssue(1)).toEqual([]);
    expect(events).toHaveLength(1);
    expect(events[0][0]).toBe('lane_file_claim_reaped');
    expect(events[0][1]).toContain('#1');
    expect(events[0][1]).toContain('issue-closed');
    expect(list).not.toHaveBeenCalled();
  });

  it('reaps a claim whose holder factory PR is merged (pr-merged)', async () => {
    const { guard, list, events, check } = await setup({ state: 'open', labels: [], title: 'Do thing' }, [
      { state: 'closed', merged_at: '2026-01-01T00:00:00Z' },
    ]);
    await expect(check()).resolves.toBeUndefined();
    expect(await guard.claimsForIssue(1)).toEqual([]);
    expect(events[0][1]).toContain('#1');
    expect(events[0][1]).toContain('pr-merged');
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ head: 'acme:factory/1-do-thing', state: 'all' }));
  });

  it('reaps a claim whose holder factory PR is closed unmerged (pr-closed)', async () => {
    const { guard, events, check } = await setup({ state: 'open', labels: [], title: 'Do thing' }, [
      { state: 'closed', merged_at: null },
    ]);
    await expect(check()).resolves.toBeUndefined();
    expect(await guard.claimsForIssue(1)).toEqual([]);
    expect(events[0][1]).toContain('pr-closed');
  });

  it('keeps a claim whose holder is an open factory:in-progress issue even when its PR is closed', async () => {
    const { guard, events, check } = await setup(
      { state: 'open', labels: [{ name: 'factory:in-progress' }], title: 'Do thing' },
      [{ state: 'closed', merged_at: null }],
    );
    await expect(check()).resolves.toEqual({ issue: 1, file: 'a.swift' });
    expect(await guard.claimsForIssue(1)).toHaveLength(1);
    expect(events).toEqual([]);
  });

  it('keeps a claim whose holder carries a live claim-expires lease', async () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    const { guard, check } = await setup(
      { state: 'open', labels: [`factory:claim-expires:${future}`], title: 'Do thing' },
      [{ state: 'closed', merged_at: null }],
    );
    await expect(check()).resolves.toEqual({ issue: 1, file: 'a.swift' });
    expect(await guard.claimsForIssue(1)).toHaveLength(1);
  });

  it('keeps a claim when the holder has an open PR', async () => {
    const { guard, check } = await setup({ state: 'open', labels: [], title: 'Do thing' }, [
      { state: 'open', merged_at: null },
      { state: 'closed', merged_at: null },
    ]);
    await expect(check()).resolves.toEqual({ issue: 1, file: 'a.swift' });
    expect(await guard.claimsForIssue(1)).toHaveLength(1);
  });

  it('keeps a claim when no PR is found', async () => {
    const { guard, check } = await setup({ state: 'open', labels: [], title: 'Do thing' }, []);
    await expect(check()).resolves.toEqual({ issue: 1, file: 'a.swift' });
    expect(await guard.claimsForIssue(1)).toHaveLength(1);
  });

  it('keeps a claim, file untouched and no event, when the lookup fails', async () => {
    const { file, events, check } = await setup(new Error('rate limited'));
    const before = await readFile(file, 'utf-8');
    await expect(check()).resolves.toEqual({ issue: 1, file: 'a.swift' });
    expect(await readFile(file, 'utf-8')).toBe(before);
    expect(events).toEqual([]);
  });

  it('reaps a closed claim and still collides with a live one in the same call', async () => {
    const file = await tmpFile();
    const guard = new LaneFileGuard(file);
    await guard.register('acme/repo', 1, ['a.swift']);
    await guard.register('acme/repo', 3, ['a.swift']);
    const isStale = async (c: { issue: number }) => (c.issue === 1 ? ('issue-closed' as const) : undefined);
    const events: string[] = [];
    const result = await guard.findCollision('acme/repo', 2, ['a.swift'], {
      isStale,
      log: (type) => events.push(type),
    });
    expect(result).toEqual({ issue: 3, file: 'a.swift' });
    expect(await guard.claimsForIssue(1)).toEqual([]);
    expect(await guard.claimsForIssue(3)).toHaveLength(1);
    expect(events).toEqual(['lane_file_claim_reaped']);
  });

  it('keeps the collision when the probe throws', async () => {
    const guard = new LaneFileGuard(await tmpFile());
    await guard.register('acme/repo', 1, ['a.swift']);
    const result = await guard.findCollision('acme/repo', 2, ['a.swift'], {
      isStale: async () => {
        throw new Error('boom');
      },
    });
    expect(result).toEqual({ issue: 1, file: 'a.swift' });
    expect(await guard.claimsForIssue(1)).toHaveLength(1);
  });

  it('does not reap a claim that was re-registered after it was probed', async () => {
    const guard = new LaneFileGuard(await tmpFile());
    await guard.register('acme/repo', 1, ['a.swift']);
    const events: string[] = [];
    const result = await guard.findCollision('acme/repo', 2, ['a.swift'], {
      isStale: async () => {
        await new Promise((r) => setTimeout(r, 5));
        await guard.register('acme/repo', 1, ['a.swift']);
        return 'issue-closed';
      },
      log: (type) => events.push(type),
    });
    expect(result).toBeUndefined();
    expect(events).toEqual([]);
  });

  it('without opts never writes the file', async () => {
    const file = await tmpFile();
    const guard = new LaneFileGuard(file);
    await guard.register('acme/repo', 1, ['a.swift']);
    const before = await readFile(file, 'utf-8');
    await expect(guard.findCollision('acme/repo', 2, ['a.swift'])).resolves.toEqual({ issue: 1, file: 'a.swift' });
    expect(await readFile(file, 'utf-8')).toBe(before);
  });
});

describe('LaneFileGuard.sweepStale', () => {
  async function seed(...issues: number[]) {
    const file = await tmpFile();
    const guard = new LaneFileGuard(file);
    for (const n of issues) await guard.register('acme/repo', n, [`f${n}.swift`]);
    const events: Array<[string, string]> = [];
    const log = (type: string, msg: string) => events.push([type, msg]);
    return { file, guard, events, log };
  }

  function fakeOctokit(issue: { state: string; labels: string[]; title: string }, prs: unknown[] = []) {
    const get = vi.fn(async () => ({ data: issue }));
    const list = vi.fn(async () => ({ data: prs }));
    return Object.assign({} as Octokit, { rest: { issues: { get }, pulls: { list } } }) as Pick<Octokit, 'rest'>;
  }

  it('sweepStale reaps a claim whose holder PR is merged and emits lane_file_claim_reaped naming #1', async () => {
    const { guard, events, log } = await seed(1);
    const octokit = fakeOctokit({ state: 'open', labels: [], title: 'Do thing' }, [
      { state: 'closed', merged_at: '2026-01-01T00:00:00Z' },
    ]);
    const reaped = await guard.sweepStale({
      isStale: createGithubLaneClaimStalenessProbe({ octokit, branchPrefix: 'factory' }),
      log,
    });
    expect(await guard.claimsForIssue(1)).toEqual([]);
    expect(reaped).toHaveLength(1);
    expect(reaped[0]).toMatchObject({ claim: { issue: 1 }, reason: 'pr-merged' });
    expect(events).toHaveLength(1);
    expect(events[0][0]).toBe('lane_file_claim_reaped');
    expect(events[0][1]).toContain('#1');
    expect(events[0][1]).toContain('pr-merged');
  });

  it('sweepStale reaps a claim whose holder issue is closed', async () => {
    const { guard, events, log } = await seed(1);
    const octokit = fakeOctokit({ state: 'closed', labels: [], title: 'X' });
    await guard.sweepStale({
      isStale: createGithubLaneClaimStalenessProbe({ octokit, branchPrefix: 'factory' }),
      log,
    });
    expect(await guard.claimsForIssue(1)).toEqual([]);
    expect(events[0][1]).toContain('issue-closed');
  });

  it('sweepStale keeps the live #3 claim while reaping the finished #1 claim', async () => {
    const { guard, events, log } = await seed(1, 3);
    const reaped = await guard.sweepStale({
      isStale: async (claim) => (claim.issue === 1 ? 'issue-closed' : undefined),
      log,
    });
    expect(reaped.map((r) => r.claim.issue)).toEqual([1]);
    expect(await guard.claimsForIssue(1)).toEqual([]);
    expect(await guard.claimsForIssue(3)).toHaveLength(1);
    expect(events.some(([, msg]) => msg.includes('#3'))).toBe(false);
  });

  it('keeps the claim when the probe throws', async () => {
    const { file, guard, events, log } = await seed(1);
    const before = await readFile(file, 'utf-8');
    const reaped = await guard.sweepStale({
      isStale: async () => {
        throw new Error('boom');
      },
      log,
    });
    expect(reaped).toEqual([]);
    expect(events).toEqual([]);
    expect(await readFile(file, 'utf-8')).toBe(before);
  });

  it('returns [] without rewriting the file when nothing is stale', async () => {
    const { file, guard } = await seed(1);
    const before = await readFile(file, 'utf-8');
    await expect(guard.sweepStale({ isStale: async () => undefined })).resolves.toEqual([]);
    expect(await readFile(file, 'utf-8')).toBe(before);
  });

  it('does not create the file when there are no claims', async () => {
    const file = await tmpFile();
    const guard = new LaneFileGuard(file);
    await expect(guard.sweepStale({ isStale: async () => 'issue-closed' })).resolves.toEqual([]);
    await expect(readFile(file, 'utf-8')).rejects.toThrow();
  });

  it('scopes to opts.repo: other repos are neither probed nor removed', async () => {
    const { guard } = await seed(1);
    await guard.register('other/repo', 5, ['z.swift']);
    const probe = vi.fn(async () => 'issue-closed' as const);
    await guard.sweepStale({ isStale: probe, repo: 'acme/repo' });
    expect(probe).toHaveBeenCalledTimes(1);
    expect(await guard.claimsForIssue(1)).toEqual([]);
    expect(await guard.claimsForIssue(5)).toHaveLength(1);
  });

  it('keeps a claim that was re-registered after it was probed', async () => {
    const { guard, events, log } = await seed(1);
    const reaped = await guard.sweepStale({
      isStale: async () => {
        await new Promise((r) => setTimeout(r, 5));
        await guard.register('acme/repo', 1, ['f1.swift']);
        return 'issue-closed';
      },
      log,
    });
    expect(reaped).toEqual([]);
    expect(events).toEqual([]);
    expect(await guard.claimsForIssue(1)).toHaveLength(1);
  });
});

describe('releaseLaneClaim', () => {
  it('releaseLaneClaim removes the #1 claim and resolves true without logging', async () => {
    const guard = new LaneFileGuard(await tmpFile());
    await guard.register('o/r', 1, ['src/a.ts']);
    const events: Array<[string, string]> = [];
    const ok = await releaseLaneClaim(guard, 'o/r', 1, (type, msg) => events.push([type, msg]));
    expect(ok).toBe(true);
    expect(await guard.claimsForIssue(1)).toEqual([]);
    expect(events).toEqual([]);
  });

  it('releaseLaneClaim logs lane_file_release_failed naming #1, resolves false and keeps the claim when the write fails', async () => {
    const file = await tmpFile();
    const guard = new LaneFileGuard(file);
    await guard.register('o/r', 1, ['src/a.ts']);
    await mkdir(`${file}.tmp`);
    const events: Array<[string, string]> = [];
    const ok = await releaseLaneClaim(guard, 'o/r', 1, (type, msg) => events.push([type, msg]));
    expect(ok).toBe(false);
    const failed = events.filter(([type]) => type === 'lane_file_release_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0][1]).toContain('#1');
    expect(await readFile(file, 'utf8')).toContain('o/r#1');
  });

  it('releaseLaneClaim on an unclaimed issue is a silent no-op', async () => {
    const file = await tmpFile();
    const guard = new LaneFileGuard(file);
    const events: Array<[string, string]> = [];
    const ok = await releaseLaneClaim(guard, 'o/r', 7, (type, msg) => events.push([type, msg]));
    expect(ok).toBe(true);
    expect(events).toEqual([]);
    await expect(readFile(file, 'utf8')).rejects.toThrow();
  });
});
