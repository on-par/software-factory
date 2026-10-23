// packages/cli/src/cli/land-rebuild.test.ts — a merge-main conflict at land rebuilds the issue once on a fresh branch (#3325)

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { phaseSnapshotFile, writePhaseSnapshot } from '@on-par/factory-core';
import { describe, expect, it, vi } from 'vitest';

import { LandConflictError, LandRebuildRequiredError, landOpenPullRequest, syncDirtyPullRequest } from './land-pr.js';
import { isRebuildBranch, rebuildBranchFor, replaceConflictedPr } from './land-rebuild.js';
import { runLane } from './run-lane.js';
import { h, installShipHarness, paths, phases, shipIssue } from './test-support/ship-harness.js';

installShipHarness();

const OLD = 'factory/42-x';
const NEW = rebuildBranchFor(OLD);
const CONFLICT_PATH = 'packages/cli/src/cli/help-groups.ts';

/** Partial test double standing in for a full dependency type. */
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- T is the caller-chosen double type
function stub<T>(value: unknown): T {
  return value as T;
}

type Landing = Parameters<typeof landOpenPullRequest>[0];

/** Fake GitHub + git for one lane run: PR 7 on OLD conflicts with main, the rebuilt PR 8 on NEW is clean or DIRTY. */
function setup({ rebuildDirty = false, shipThrows = false, shipOutcome = 'ready' as 'ready' | 'draft' } = {}) {
  const commands: Array<{ branch: string; command: string }> = [];
  const created: Array<{ head: string; body: string }> = [];
  const updated: unknown[] = [];
  const comments: Array<{ issue_number: number; body: string }> = [];
  const deleted: string[] = [];
  const events: Array<{ type: string; msg: string; extra?: any }> = [];
  const shipCtx: any[] = [];
  let current = OLD;
  let synced = false;
  const octokit = {
    graphql: async () => ({
      repository: {
        pullRequest: {
          id: 'PR',
          isDraft: false,
          mergeStateStatus: current === NEW && rebuildDirty && !synced ? 'DIRTY' : 'CLEAN',
        },
      },
    }),
    rest: {
      pulls: {
        get: async () => ({ data: { head: { sha: 'sha' } } }),
        merge: async () => {},
        create: async (args: { head: string; body: string }) => {
          created.push({ head: args.head, body: args.body });
          return { data: { number: 8 } };
        },
        update: async (args: unknown) => {
          updated.push(args);
        },
      },
      issues: {
        createComment: async (args: { issue_number: number; body: string }) => {
          comments.push(args);
        },
      },
      git: {
        deleteRef: async (args: { ref: string }) => {
          deleted.push(args.ref);
        },
      },
    },
  };
  const run = async (command: string) => {
    commands.push({ branch: current, command });
    if (command === 'git status --porcelain -z') return { stdout: '' };
    if (command.startsWith('git rev-parse --git-path')) return { stdout: '.git/operation' };
    if (command.startsWith('test -e')) return { stdout: 'no' };
    if (command === 'git rev-parse --verify HEAD' || command.startsWith('git merge-base'))
      return { stdout: 'a'.repeat(40) };
    if (command.startsWith('git diff --diff-filter=A')) return { stdout: '' };
    if (command === 'git merge --no-edit origin/main' && (current === OLD || rebuildDirty)) throw new Error('CONFLICT');
    if (command.startsWith('git diff --name-only --diff-filter=U -z')) return { stdout: `${CONFLICT_PATH}\0` };
    if (command.startsWith('git push')) synced = true;
    return { stdout: '' };
  };
  const waitMerge = async (
    _issue: number,
    branch: string,
    _root: string,
    _gh: string,
    _paths: unknown,
    d: { syncMain?: boolean; rebuildOnConflict?: boolean } = {},
  ) => {
    current = branch;
    await landOpenPullRequest({
      octokit: stub<Landing['octokit']>(octokit),
      owner: 'on-par',
      repoName: 'software-factory',
      ghRepo: 'on-par/software-factory',
      repoRoot: '/repo',
      issue: 42,
      branch,
      worktree: '/repo-factory-42',
      prNumber: branch === NEW ? 8 : 7,
      log: (type, msg, extra) => events.push({ type, msg, extra }),
      run,
      pathExists: () => true,
      sleep: async () => {},
      adminMerge: false,
      skipCI: true,
      withLock: (fn) => fn(),
      ...(d.syncMain ? { syncMain: true } : {}),
      ...(d.rebuildOnConflict ? { rebuildOnConflict: true } : {}),
    });
  };
  const ship = vi.fn(async (_issue: number, _opts: unknown, ctx: any) => {
    shipCtx.push(ctx);
    if (shipThrows) throw new Error('build exploded');
    const branch = ctx.rebuild.branch as string;
    await octokit.rest.pulls.create({ head: branch, body: 'Closes #42' });
    ctx.onOutcome({ state: 'ready', prNumber: 8, ...(shipOutcome === 'draft' ? { draft: true } : {}) });
    return branch;
  });
  const lane = async (extra: Record<string, unknown> = {}) => {
    const claims = [{ issue: 42, decision: { kind: 'adopt' as const, branch: OLD, syncMain: true as const } }];
    const released: string[] = [];
    await runLane(
      'app',
      [],
      '/repo',
      'on-par/software-factory',
      { events: '/x/events', stop: '/x/STOP', runs: join(h.repoRoot, 'runs') } as any,
      {
        claimNext: async () => claims.shift() ?? null,
        ship: ship as any,
        waitMerge: waitMerge as any,
        replacePr: (issue, oldPr, newPr, ps) =>
          replaceConflictedPr({
            octokit: octokit as any,
            repo: 'on-par/software-factory',
            issue,
            oldPr,
            newPr,
            paths: ps,
          }),
        releaseIssue: async (_i, outcome) => {
          released.push(outcome);
        },
        pathExists: () => false,
        emitEvent: ((_f: string, type: string, _i: number, msg: string, extra: any) =>
          events.push({ type, msg, extra })) as any,
        ...extra,
      },
    );
    return released;
  };
  return { commands, created, updated, comments, deleted, events, shipCtx, ship, lane };
}

describe('rebuild branch naming', () => {
  it('suffixes the branch and recognises a rebuild branch', () => {
    expect(rebuildBranchFor(OLD)).toBe('factory/42-x-rebuild');
    expect(isRebuildBranch(NEW)).toBe(true);
    expect(isRebuildBranch(OLD)).toBe(false);
  });
});

describe('land rebuild (#3325)', () => {
  it('a merge-main conflict rebuilds on a fresh branch and replaces the PR', async () => {
    const t = setup();
    const released = await t.lane();
    expect(t.shipCtx).toHaveLength(1);
    expect(t.shipCtx[0].rebuild).toEqual({ branch: NEW });
    expect(t.created).toEqual([{ head: NEW, body: 'Closes #42' }]);
    expect(t.updated).toContainEqual(expect.objectContaining({ pull_number: 7, state: 'closed' }));
    expect(t.comments.find((c) => c.issue_number === 7)?.body).toContain('#8');
    expect(t.deleted).not.toContain(`heads/${OLD}`);
    const refresh = t.events.find((e) => e.type === 'pr_refresh' && e.extra?.prRefresh?.action === 'rebuild');
    expect(refresh?.extra.prRefresh).toMatchObject({ pr: 7, action: 'rebuild', newPr: 8 });
    expect(t.events.some((e) => e.extra?.prRefresh?.action === 'merge-main')).toBe(true);
    expect(released).toEqual(['done']);
  });

  it('a failed rebuild BUILD parks conflict naming the stage and the conflicting paths', async () => {
    const now = new Date().toISOString();
    await writePhaseSnapshot(phaseSnapshotFile(join(h.repoRoot, 'runs'), 42), {
      issue: 42,
      phase: 'build',
      updatedAt: now,
      lastActivityAt: now,
    });
    const t = setup({ shipThrows: true });
    const released = await t.lane();
    const conflict = t.events.find((e) => e.type === 'conflict' && e.msg.includes('rebuild of PR #7'));
    expect(conflict?.msg).toContain('build');
    expect(conflict?.msg).toContain('help-groups.ts');
    const parked = t.events.find((e) => e.type === 'parked');
    expect(parked?.extra.park.reason).toBe('conflict');
    expect(released).toEqual(['parked']);
    expect(t.updated).toEqual([]);
  });

  it('a draft rebuild result parks conflict at the ship stage', async () => {
    const t = setup({ shipOutcome: 'draft' });
    await t.lane();
    expect(t.events.find((e) => e.type === 'conflict' && e.msg.includes('failed at ship'))).toBeDefined();
    expect(t.events.find((e) => e.type === 'parked')?.extra.park.reason).toBe('conflict');
  });

  it('a conflict on the rebuilt PR parks conflict and opens no third PR', async () => {
    const t = setup({ rebuildDirty: true });
    const released = await t.lane();
    expect(t.ship).toHaveBeenCalledTimes(1);
    expect(t.created).toHaveLength(1);
    expect(t.events.find((e) => e.type === 'parked')?.extra.park.reason).toBe('conflict');
    expect(released).toEqual(['parked']);
  });

  it('a failing replacePr only warns and the rebuilt PR still lands', async () => {
    const t = setup();
    const released = await t.lane({
      replacePr: async () => {
        throw new Error('403');
      },
    });
    expect(t.events.some((e) => e.type === 'warn' && e.msg.includes('could not close PR #7'))).toBe(true);
    expect(released).toEqual(['done']);
  });

  it('land hands the rebuild to the lane and the rebuild reuses the frozen spec without PLAN', async () => {
    // (a) land itself only runs git and throws the typed signal.
    const commands: string[] = [];
    const octokit = {
      graphql: async () => ({ repository: { pullRequest: { id: 'PR', mergeStateStatus: 'DIRTY' } } }),
      rest: {},
    };
    const run = async (command: string) => {
      commands.push(command);
      if (command === 'git merge --no-edit origin/main') throw new Error('CONFLICT');
      if (command.startsWith('git diff --name-only --diff-filter=U -z')) return { stdout: `${CONFLICT_PATH}\0` };
      if (command.startsWith('git rev-parse --git-path')) return { stdout: '.git/x' };
      if (command.startsWith('test -e')) return { stdout: 'no' };
      if (command === 'git rev-parse --verify HEAD' || command.startsWith('git merge-base'))
        return { stdout: 'b'.repeat(40) };
      return { stdout: '' };
    };
    const err = await landOpenPullRequest({
      octokit: stub<Landing['octokit']>(octokit),
      owner: 'o',
      repoName: 'r',
      ghRepo: 'o/r',
      repoRoot: '/repo',
      issue: 42,
      branch: OLD,
      worktree: '/wt',
      prNumber: 7,
      log: () => {},
      run,
      pathExists: () => true,
      withLock: (fn) => fn(),
      rebuildOnConflict: true,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LandRebuildRequiredError);
    expect((err as LandRebuildRequiredError).paths).toEqual([CONFLICT_PATH]);
    expect((err as LandRebuildRequiredError).mergeStateStatus).toBe('DIRTY');
    expect(commands.every((c) => c.startsWith('git ') || c.startsWith('test -e'))).toBe(true);

    // (b) the lane's ship with ctx.rebuild runs BUILD from the frozen spec and never calls PLAN.
    writeFileSync(join(paths().plans, 'issue-5.md'), '---\nroute: claude\n---\n# spec\n');
    const realPlan = phases.planPhase;
    await shipIssue(5, {}, { repoRoot: h.repoRoot, ghRepo: h.ghRepo, rebuild: { branch: 'factory/5-x-rebuild' } });
    expect(realPlan).not.toHaveBeenCalled();
    expect(phases.buildPhase).toHaveBeenCalled();
    expect(phases.buildPhase.mock.calls[0]?.[0]).toMatchObject({ branch: 'factory/5-x-rebuild' });
  });
});

describe('syncDirtyPullRequest rebuild opt-in', () => {
  const sync = (opts: { rebuildOnConflict?: boolean; conflict: boolean }) => {
    const run = async (command: string) => {
      if (command === 'git merge --no-edit origin/main') throw new Error('CONFLICT');
      if (command.startsWith('git diff --name-only --diff-filter=U -z')) return { stdout: `${CONFLICT_PATH}\0` };
      if (command.startsWith('git rev-parse --git-path')) return { stdout: '.git/x' };
      if (command.startsWith('test -e')) return { stdout: 'no' };
      if (command === 'git rev-parse --verify HEAD' || command.startsWith('git merge-base'))
        return { stdout: 'b'.repeat(40) };
      if (command === 'git status --porcelain -z') return { stdout: opts.conflict ? '' : ' M dirty.ts\0' };
      return { stdout: '' };
    };
    return syncDirtyPullRequest({
      issue: 42,
      branch: OLD,
      worktree: '/wt',
      prNumber: 7,
      log: () => {},
      run,
      pathExists: () => true,
      ...(opts.rebuildOnConflict ? { rebuildOnConflict: true } : {}),
    }).catch((e: unknown) => e);
  };

  it('without the opt-in a real conflict is a plain LandConflictError', async () => {
    const err = await sync({ conflict: true });
    expect(err).toBeInstanceOf(LandConflictError);
    expect(err).not.toBeInstanceOf(LandRebuildRequiredError);
  });

  it('a non-conflict sync failure never asks for a rebuild', async () => {
    const err = await sync({ conflict: false, rebuildOnConflict: true });
    expect(err).toBeInstanceOf(LandConflictError);
    expect(err).not.toBeInstanceOf(LandRebuildRequiredError);
  });
});
