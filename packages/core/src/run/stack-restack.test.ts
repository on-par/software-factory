// packages/core/src/run/stack-restack.test.ts — ADR-0161 (#3368): restack open slices after a squash merge, on a real git fixture.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Octokit } from '@octokit/rest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderStackOrderLine, STACK_ORDER_MARKER } from '../phases/stack-order.js';
import { withSliceState, type SlicePlan } from '../readiness/slice-plan.js';
import { restackAfterSquashMerge } from './stack-restack.js';

const identity = ['-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false'];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', [...identity, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function commit(cwd: string, file: string, content: string, msg: string): void {
  writeFileSync(join(cwd, file), content);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-m', msg);
}

const story = {} as never;
const emptyPlan = (): SlicePlan => ({
  issue: 9,
  slices: [1, 2, 3].map((index) => ({ index, title: `S${index}`, story, state: 'pending' as const })),
});

describe('restackAfterSquashMerge', () => {
  let dir: string;
  let remote: string;
  let root: string;
  let plan: SlicePlan;
  let slice1Head: string;
  let update: ReturnType<typeof vi.fn<(args: Record<string, unknown>) => Promise<unknown>>>;
  let savePlan: ReturnType<typeof vi.fn<(plan: SlicePlan) => Promise<void>>>;
  let baseRef: Record<number, string>;

  const octokit = (): Octokit => {
    const stub: Octokit = {
      rest: {
        pulls: {
          get: vi.fn(async ({ pull_number }: { pull_number: number }) => ({
            data:
              pull_number === 101
                ? { head: { sha: slice1Head }, base: { ref: 'main' }, body: '' }
                : {
                    head: { sha: 'x' },
                    base: { ref: baseRef[pull_number] ?? 'factory/9-slice-1' },
                    body: `## Summary\n\nx\n\n${renderStackOrderLine({ index: pull_number - 100, count: 3, base: 'factory/9-slice-1', basePr: 101 })}\n`,
                  },
          })),
          update,
        },
      },
    } as never;
    return stub;
  };

  const run = (over: Partial<Parameters<typeof restackAfterSquashMerge>[0]> = {}) =>
    restackAfterSquashMerge({
      repoRoot: root,
      octokit: octokit(),
      repo: 'o/r',
      plan,
      mergedIndex: 1,
      mergedPrNumber: 101,
      savePlan,
      ...over,
    });

  const remoteHead = (branch: string): string => git(remote, 'rev-parse', `refs/heads/${branch}`);
  const remoteLog = (branch: string): string[] =>
    git(remote, 'log', '--format=%s', `main..${branch}`).split('\n').filter(Boolean);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'restack-test-'));
    remote = join(dir, 'remote.git');
    root = join(dir, 'root');
    update = vi.fn(async () => ({}));
    savePlan = vi.fn(async () => {});
    baseRef = {};
    git(dir, 'init', '--bare', '-b', 'main', remote);
    git(dir, 'clone', remote, root);
    git(root, 'checkout', '-b', 'main');
    commit(root, 'a.txt', 'base\n', 'base');
    git(root, 'push', 'origin', 'main');
    git(root, 'checkout', '-b', 'factory/9-slice-1');
    commit(root, 's1a.txt', '1a\n', 's1 first');
    commit(root, 's1b.txt', '1b\n', 's1 second');
    slice1Head = git(root, 'rev-parse', 'HEAD');
    git(root, 'push', 'origin', 'factory/9-slice-1');
    git(root, 'checkout', '-b', 'factory/9-slice-2');
    commit(root, 's2.txt', '2\n', 's2 only');
    const head2 = git(root, 'rev-parse', 'HEAD');
    git(root, 'push', 'origin', 'factory/9-slice-2');
    git(root, 'checkout', '-b', 'factory/9-slice-3');
    commit(root, 's3.txt', '3\n', 's3 only');
    const head3 = git(root, 'rev-parse', 'HEAD');
    git(root, 'push', 'origin', 'factory/9-slice-3');
    // Squash slice 1 onto main and delete its branch.
    git(root, 'checkout', 'main');
    git(root, 'merge', '--squash', 'factory/9-slice-1');
    git(root, 'commit', '-m', 'squash slice 1');
    git(root, 'push', 'origin', 'main');
    git(root, 'push', 'origin', '--delete', 'factory/9-slice-1');
    plan = withSliceState(emptyPlan(), 1, 'merged', 101);
    plan = withSliceState(plan, 2, 'pr-open', 102, 'factory/9-slice-2', head2);
    plan = withSliceState(plan, 3, 'pr-open', 103, 'factory/9-slice-3', head3);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('rebases the next slice onto main after its parent is squash-merged and retargets it', async () => {
    const out = await run({ plan: withSliceState(plan, 3, 'pending') });
    expect(out.status).toBe('restacked');
    expect(remoteLog('factory/9-slice-2')).toEqual(['s2 only']);
    expect(update).toHaveBeenCalledTimes(1);
    const arg = update.mock.calls[0]![0] as { pull_number: number; base: string; body: string };
    expect(arg.pull_number).toBe(102);
    expect(arg.base).toBe('main');
    expect(arg.body).toContain('stacked on `main`');
    expect(arg.body).toContain(STACK_ORDER_MARKER);
  });

  it("rebases slice 3 onto slice 2's new head and records both head SHAs", async () => {
    const out = await run();
    expect(out.status).toBe('restacked');
    const head2 = remoteHead('factory/9-slice-2');
    expect(git(remote, 'rev-parse', 'factory/9-slice-3^')).toBe(head2);
    expect(remoteLog('factory/9-slice-3')).toEqual(['s3 only', 's2 only']);
    expect(update.mock.calls.filter((c) => (c[0] as { pull_number: number }).pull_number === 103)).toEqual([]);
    const saved = savePlan.mock.calls[0]![0] as SlicePlan;
    expect(saved.slices.map((s) => s.headSha)).toEqual([undefined, head2, remoteHead('factory/9-slice-3')]);
  });

  it('still rebases with --onto when GitHub already retargeted the PR to main', async () => {
    baseRef[102] = 'main';
    const out = await run({ plan: withSliceState(plan, 3, 'pending') });
    expect(out.status).toBe('restacked');
    expect(remoteLog('factory/9-slice-2')).toEqual(['s2 only']);
    for (const c of update.mock.calls) expect(c[0]).not.toHaveProperty('base');
    expect(out.status === 'restacked' && out.retargeted).toBe(false);
  });

  it('refuses to clobber a human push to the slice branch', async () => {
    git(root, 'checkout', 'factory/9-slice-2');
    commit(root, 'human.txt', 'h\n', 'human fix');
    git(root, 'push', 'origin', 'factory/9-slice-2');
    const humanHead = remoteHead('factory/9-slice-2');
    const out = await run();
    expect(out.status).toBe('park');
    expect(out.status === 'park' && out.reason).toContain('slice 2');
    expect(out.status === 'park' && out.reason).toContain('#102');
    expect(remoteHead('factory/9-slice-2')).toBe(humanHead);
    expect(update).not.toHaveBeenCalled();
  });

  it('parks naming the slice, its PR and the conflicting files on a rebase conflict', async () => {
    git(root, 'checkout', 'factory/9-slice-2');
    commit(root, 'a.txt', 'slice two edit\n', 's2 edits a');
    git(root, 'push', 'origin', 'factory/9-slice-2');
    plan = withSliceState(plan, 2, 'pr-open', 102, 'factory/9-slice-2', remoteHead('factory/9-slice-2'));
    git(root, 'checkout', 'main');
    commit(root, 'a.txt', 'main edit\n', 'main edits a');
    git(root, 'push', 'origin', 'main');
    const before = remoteHead('factory/9-slice-2');
    const out = await run({ plan: withSliceState(plan, 3, 'pending') });
    expect(out).toMatchObject({ status: 'park', index: 2, prNumber: 102, files: ['a.txt'] });
    expect(out.status === 'park' && out.reason).toContain('slice 2/3 PR #102');
    expect(out.status === 'park' && out.reason).toContain('a.txt');
    expect(remoteHead('factory/9-slice-2')).toBe(before);
    expect(
      readdirSync(tmpdir()).filter((f) => f.startsWith('factory-restack-') && existsSync(join(tmpdir(), f, '.git'))),
    ).toEqual([]);
  });

  it('pushes nothing when a higher slice conflicts', async () => {
    git(root, 'checkout', 'factory/9-slice-3');
    commit(root, 's2.txt', 'slice three edit\n', 's3 edits s2 file');
    git(root, 'push', 'origin', 'factory/9-slice-3');
    plan = withSliceState(plan, 3, 'pr-open', 103, 'factory/9-slice-3', remoteHead('factory/9-slice-3'));
    git(root, 'checkout', 'factory/9-slice-2');
    commit(root, 's2.txt', 'slice two rewrite\n', 's2 rewrite');
    git(root, 'push', 'origin', 'factory/9-slice-2');
    plan = withSliceState(plan, 2, 'pr-open', 102, 'factory/9-slice-2', remoteHead('factory/9-slice-2'));
    // slice 3 was built on the older slice 2 head, so replaying it onto the rewritten one conflicts.
    const before2 = remoteHead('factory/9-slice-2');
    const out = await run();
    expect(out).toMatchObject({ status: 'park', index: 3 });
    expect(remoteHead('factory/9-slice-2')).toBe(before2);
    expect(update).not.toHaveBeenCalled();
  });

  it('returns nothing when the branch no longer holds the merged head', async () => {
    const first = await run({ plan: withSliceState(plan, 3, 'pending') });
    expect(first.status).toBe('restacked');
    const next = first.status === 'restacked' ? first.plan : plan;
    const second = await run({ plan: next });
    expect(second.status).toBe('nothing');
  });

  it('returns nothing when no slice above is open', async () => {
    const out = await run({ plan: withSliceState(withSliceState(plan, 2, 'merged'), 3, 'merged') });
    expect(out.status).toBe('nothing');
  });

  it('parks when an open slice has no recorded head SHA', async () => {
    const noHead: SlicePlan = {
      ...plan,
      slices: plan.slices.map((s) => (s.index === 2 ? { ...s, headSha: undefined } : s)),
    };
    const out = await run({ plan: noHead });
    expect(out.status === 'park' && out.reason).toContain('no recorded head SHA');
  });

  it('parks when an open slice branch is not factory-owned', async () => {
    const out = await run({ plan: withSliceState(plan, 2, 'pr-open', 102, 'contributor/x', 'abc') });
    expect(out.status === 'park' && out.reason).toContain('not factory-owned');
  });

  it('parks after the push when saving the plan fails', async () => {
    savePlan.mockRejectedValueOnce(new Error('comment gone'));
    const out = await run({ plan: withSliceState(plan, 3, 'pending') });
    expect(out.status === 'park' && out.reason).toContain('comment gone');
    expect(remoteLog('factory/9-slice-2')).toEqual(['s2 only']);
  });
});
