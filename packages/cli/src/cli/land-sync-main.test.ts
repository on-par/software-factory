import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import './index.js';
import { waitForMerge } from './land.js';
import { LandConflictError, landOpenPullRequest } from './land-pr.js';
import { preflightQueuedIssue } from './queue-preflight.js';

function setup(initial: 'DIRTY' | 'CLEAN', { conflict = false, syncMain = false } = {}) {
  const commands: string[] = [];
  const watched: string[] = [];
  const merges: Array<string | undefined> = [];
  const logs: Array<{ type: string; msg: string }> = [];
  let synced = false;
  const octokit: any = {
    graphql: async () => ({
      repository: {
        pullRequest: {
          id: 'PR_1',
          isDraft: false,
          mergeStateStatus: initial === 'DIRTY' && !synced ? 'DIRTY' : 'CLEAN',
        },
      },
    }),
    rest: {
      pulls: {
        get: async () => ({
          data: { head: { sha: initial === 'DIRTY' ? (synced ? 'new-sha' : 'old-sha') : 'same-sha' } },
        }),
        merge: async (args: any) => {
          merges.push(args.sha);
        },
      },
      git: { deleteRef: async () => {} },
    },
  };
  const run = async (command: string) => {
    commands.push(command);
    if (command === 'git status --porcelain -z') return { stdout: '' };
    if (command.startsWith('git rev-parse --git-path')) return { stdout: '.git/operation' };
    if (command.startsWith('test -e')) return { stdout: 'no' };
    if (command === 'git rev-parse --verify HEAD' || command.startsWith('git merge-base'))
      return { stdout: 'a'.repeat(40) };
    if (command.startsWith('git diff --diff-filter=A')) return { stdout: '' };
    if (command === 'git merge --no-edit origin/main' && conflict) throw new Error('CONFLICT');
    if (command.startsWith('git diff --name-only --diff-filter=U -z')) return { stdout: conflict ? 'src/x.ts\0' : '' };
    if (command.startsWith('git push')) synced = true;
    return { stdout: '' };
  };
  const land = (extra: { syncMain?: boolean } = { syncMain }) =>
    landOpenPullRequest({
      octokit,
      owner: 'on-par',
      repoName: 'software-factory',
      ghRepo: 'on-par/software-factory',
      repoRoot: '/repo',
      issue: 20,
      branch: 'factory/20-x',
      worktree: '/repo-factory-20',
      prNumber: 123,
      log: (type, msg) => logs.push({ type, msg }),
      run,
      pathExists: () => true,
      sleep: async () => {},
      adminMerge: false,
      watch: (async (o: { ref: string }) => {
        watched.push(o.ref);
        return 'success';
      }) as any,
      withLock: (fn) => fn(),
      ...extra,
    });
  return { commands, watched, merges, logs, land };
}

const preflightDeps = (mergeStateStatus: string) => ({
  expectedHeadRepoFullName: 'on-par/software-factory',
  findSlicePlan: async () => ({ status: 'not-found' as const }),
  findOpenPR: async () => ({
    number: 123,
    branch: 'factory/20-x',
    headSha: 'old-sha',
    headRepoFullName: 'on-par/software-factory',
  }),
  getLandState: async () => ({ isDraft: false, mergeStateStatus }),
  watch: vi.fn(async (_ref: string) => 'success' as const),
  saveSlicePlan: async () => {},
  autoMergeStack: false,
  stackMode: false,
  getPullReviews: async () => {
    throw new Error('unexpected review lookup');
  },
  readIssueBody: async () => '',
  getMergedClosingPr: async () => undefined,
  getPrerequisiteState: async () => {
    throw new Error('unexpected prerequisite lookup');
  },
  getPullState: async () => 'open' as const,
  getPullRefs: async () => {
    throw new Error('unexpected refs lookup');
  },
  branchContains: async () => false,
  sleep: async () => {},
});

describe('syncMain adopt (#3324)', () => {
  it('a DIRTY open PR is synced by merging origin/main and a plain push, never a force-push', async () => {
    const deps = preflightDeps('DIRTY');
    const decision = await preflightQueuedIssue({ number: 20, labels: [] }, deps);
    expect(decision).toEqual({ kind: 'adopt', branch: 'factory/20-x', syncMain: true });
    expect(deps.watch).not.toHaveBeenCalled();

    const h = setup('DIRTY');
    await h.land({ syncMain: decision.kind === 'adopt' && decision.syncMain });
    expect(h.commands).toContain('git merge --no-edit origin/main');
    expect(h.commands.some((c) => c.startsWith('git push origin'))).toBe(true);
    expect(h.commands.some((c) => c.includes('--force'))).toBe(false);
    expect(h.watched).toEqual(['new-sha']);
    expect(h.merges).toEqual(['new-sha']);
    const refresh = h.logs.filter((l) => l.type === 'pr_refresh');
    expect(refresh).toHaveLength(1);
    expect(refresh[0].msg).toContain('PR #123');
    expect(refresh[0].msg).toContain('mergeStateStatus=DIRTY');
    expect(refresh[0].msg).toContain('action=merge-main');
  });

  it('a syncMain land on a CLEAN PR runs the merge, watches CI on the unchanged head and merges', async () => {
    const h = setup('CLEAN', { syncMain: true });
    await h.land();
    expect(h.commands).toContain('git merge --no-edit origin/main');
    expect(h.commands.some((c) => c.startsWith('git push'))).toBe(true);
    expect(h.watched).toEqual(['same-sha']);
    expect(h.merges).toEqual(['same-sha']);
    expect(h.logs.find((l) => l.type === 'pr_refresh')?.msg).toContain('mergeStateStatus=CLEAN');
  });

  it('a syncMain land that conflicts on a non-ADR path throws LandConflictError and never pushes', async () => {
    const h = setup('CLEAN', { conflict: true, syncMain: true });
    const err = await h.land().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LandConflictError);
    expect((err as LandConflictError).message).toContain('unresolved merge conflicts: src/x.ts');
    expect(h.commands.some((c) => c.startsWith('git push'))).toBe(false);
    expect(h.merges).toEqual([]);
  });

  it('without syncMain a CLEAN PR is not synced', async () => {
    const h = setup('CLEAN');
    await h.land();
    expect(h.commands).not.toContain('git merge --no-edit origin/main');
    expect(h.logs.some((l) => l.type === 'pr_refresh')).toBe(false);
    expect(h.merges).toEqual(['same-sha']);
  });

  it('waitForMerge forwards syncMain to land only when set', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sync-main-wait-'));
    const paths: any = {
      events: join(root, 'events.ndjson'),
      stop: join(root, 'STOP'),
      runs: join(root, 'runs'),
      laneFiles: join(root, 'lane-files.json'),
    };
    const run = async (syncMain?: boolean) => {
      const land = vi.fn(async (..._args: unknown[]) => ({ branch: 'factory/20-x', prNumber: 123 }));
      await waitForMerge(20, 'factory/20-x', '/repo', 'on-par/software-factory', paths, {
        createOctokit: () => ({}) as any,
        pathExists: () => false,
        checkMerged: async () => false,
        mergeEnabled: () => true,
        loadConfig: () =>
          ({ merge: { auto: true, comment: '' }, filing: { enabled: false, selfFixLabel: 'no-auto-merge' } }) as any,
        listIssueLabels: async () => [],
        land: land as any,
        emitEvent: () => {},
        sleep: async () => {},
        ...(syncMain ? { syncMain } : {}),
      });
      return land.mock.calls[0]?.[7];
    };
    expect(await run(true)).toMatchObject({ syncMain: true });
    expect(await run()).toEqual({ enforceRisk: true });
    await rm(root, { recursive: true, force: true });
  });
});
