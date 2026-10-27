// packages/cli/src/cli/land-rebuild.test.ts — a merge-main conflict at land is rebuilt by the lane on a fresh branch (#3325)
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { logEvent } from '@on-par/factory-core/internal';
import { describe, expect, it, vi } from 'vitest';

import { LandConflictError, landOpenPullRequest } from './land-pr.js';
import { ClaimLostError } from './lane-heartbeat.js';
import {
  closeReplacedPullRequest,
  isRebuildBranch,
  landWithOneRebuild,
  rebuildBranchFor,
  type LandRebuildOps,
} from './land-rebuild.js';
import { runLane, type RunLaneDeps } from './run-lane.js';
import { h, installShipHarness, paths, phases, setupWorktree, shipIssue } from './test-support/ship-harness.js';

installShipHarness();

const REPO = 'on-par/software-factory';
const ISSUE = 42;
const OLD = 'factory/42-fix-help';
const NEW = rebuildBranchFor(OLD);
const HELP_GROUPS = 'packages/cli/src/cli/help-groups.ts';

/** A recording git runner: `git merge origin/main` conflicts on help-groups.ts. */
function conflictingGit() {
  const commands: string[] = [];
  const run = async (command: string) => {
    commands.push(command);
    if (command.startsWith('git rev-parse --git-path')) return { stdout: '.git/x' };
    if (command.startsWith('test -e')) return { stdout: 'no' };
    if (command === 'git rev-parse --verify HEAD' || command.startsWith('git merge-base'))
      return { stdout: 'a'.repeat(40) };
    if (command === 'git merge --no-edit origin/main') throw new Error('CONFLICT (content)');
    if (command === 'git diff --name-only --diff-filter=U -z') return { stdout: `${HELP_GROUPS}\0` };
    return { stdout: '' };
  };
  return { commands, run };
}

/** Records the PR calls of SHIP (create) and of the replacement (comment, close). */
function fakeGitHub() {
  const created: Array<{ number: number; head: string; body: string }> = [];
  const comments: Array<{ issue_number: number; body: string }> = [];
  const closed: number[] = [];
  const rest = {
    issues: {
      createComment: vi.fn(async (a: { issue_number: number; body: string }) => {
        comments.push({ issue_number: a.issue_number, body: a.body });
        return {};
      }),
    },
    pulls: {
      update: vi.fn(async (a: { pull_number: number; state?: string }) => {
        if (a.state === 'closed') closed.push(a.pull_number);
        return {};
      }),
    },
  };
  // The SHIP phase double opens the PR with the body SHIP writes for a GitHub issue.
  phases.shipPhase.mockImplementation(async (o) => {
    const number = 124 + created.length;
    created.push({ number, head: o.branch, body: `Implements #${o.issue}.\n\nCloses #${o.issue}` });
    return { ok: true, prNumber: number };
  });
  return { created, comments, closed, octokit: { rest } as never };
}

const landOctokit = {
  graphql: async () => ({ repository: { pullRequest: { id: 'PR', isDraft: false, mergeStateStatus: 'DIRTY' } } }),
  rest: { pulls: { get: async () => ({ data: { head: { sha: 'b'.repeat(40) }, base: { ref: 'main' } } }) } },
} as never;

/** Runs one lane over an adopted DIRTY PR. Land is real down to the git runner; `conflicts(branch)` decides
 *  whether that branch's merge with origin/main conflicts, and a branch that does not conflict lands. */
async function runAdoptedConflict(
  opts: {
    conflicts?: (branch: string) => boolean;
    branch?: string;
    closeReplacedPr?: RunLaneDeps['closeReplacedPr'];
  } = {},
) {
  const { conflicts = () => true, branch = OLD } = opts;
  const github = fakeGitHub();
  const lands: Array<{ branch: string; deps: Record<string, unknown>; buildsBefore: number }> = [];
  const waitMerge: RunLaneDeps['waitMerge'] = async (issue, b, _root, _gh, _paths, deps = {}) => {
    lands.push({ branch: b, deps, buildsBefore: phases.buildPhase.mock.calls.length });
    if (!conflicts(b)) return;
    await landOpenPullRequest({
      octokit: landOctokit,
      owner: 'on-par',
      repoName: 'software-factory',
      ghRepo: REPO,
      repoRoot: h.repoRoot,
      issue,
      branch: b,
      worktree: join(h.repoRoot, 'wt'),
      prNumber: isRebuildBranch(b) ? 124 : 123,
      log: (type, msg, extra) => logEvent(paths().events, type, issue, msg, extra),
      run: conflictingGit().run,
      pathExists: () => true,
      behindProbe: async () => false,
      rebuildOnConflict: deps.rebuildOnConflict,
    });
  };
  const releaseIssue = vi.fn(async () => {});
  const claimNext = vi
    .fn()
    .mockResolvedValueOnce({ issue: ISSUE, decision: { kind: 'adopt', branch, syncMain: true } })
    .mockResolvedValue(null);
  await runLane('bugfix', [], h.repoRoot, REPO, paths() as never, {
    claimNext,
    ship: (i, o, c) => shipIssue(i, o, c),
    waitMerge,
    closeReplacedPr: opts.closeReplacedPr ?? ((r) => closeReplacedPullRequest(REPO, r, github.octokit)),
    releaseIssue,
  });
  const events = readFileSync(paths().events, 'utf-8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { type: string; msg: string; park?: { reason: string } });
  return { ...github, lands, releaseIssue, events };
}

function freezeSpec(route = 'claude'): void {
  writeFileSync(join(paths().plans, `issue-${ISSUE}.md`), `---\nroute: ${route}\n---\n# frozen spec\n`);
}

describe('land rebuild on a merge-main conflict (#3325)', () => {
  it('a merge-main conflict rebuilds on a fresh branch and replaces the PR', async () => {
    freezeSpec();
    const r = await runAdoptedConflict({ conflicts: (b) => b === OLD });

    expect(r.created).toEqual([{ number: 124, head: NEW, body: expect.stringContaining(`Closes #${ISSUE}`) }]);
    expect(setupWorktree.mock.calls.map((c) => [c[1], c[3]])).toEqual([[NEW, undefined]]); // fresh off origin/main
    expect(r.comments).toEqual([{ issue_number: 123, body: expect.stringContaining('replaced this PR with #124') }]);
    expect(r.comments[0].body).toContain(HELP_GROUPS);
    expect(r.closed).toEqual([123]);
    expect(r.lands.map((l) => [l.branch, l.deps.landBranch])).toEqual([
      [OLD, undefined],
      [NEW, NEW],
    ]);
    expect(r.events.find((e) => e.type === 'pr_refresh' && e.msg.includes('action=rebuild'))?.msg).toBe(
      'PR #123 refreshed: mergeStateStatus=DIRTY action=rebuild newPr=#124',
    );
    expect(r.releaseIssue).toHaveBeenCalledWith(ISSUE, 'done');
    expect(r.events.some((e) => e.type === 'conflict' || e.type === 'parked')).toBe(false);
  });

  it('land makes no BUILD call; the lane runs BUILD from the frozen spec and makes no PLAN call', async () => {
    freezeSpec('codex');
    const r = await runAdoptedConflict({ conflicts: (b) => b === OLD });

    expect(r.lands[0].deps.rebuildOnConflict).toBe(true);
    expect(r.lands[0].buildsBefore).toBe(0);
    expect(phases.buildPhase).toHaveBeenCalledTimes(1);
    expect(phases.planPhase).not.toHaveBeenCalled();
    expect(r.events.some((e) => e.type === 'plan_reused')).toBe(true);
  });

  it('a rebuild whose BUILD fails parks conflict with the failing stage and the conflicting path', async () => {
    freezeSpec();
    h.buildResult = { ok: false, escalate: 'build broke' };
    const r = await runAdoptedConflict();

    const conflict = r.events.find((e) => e.type === 'conflict');
    expect(conflict?.msg).toContain('rebuild of PR #123 failed at build');
    expect(conflict?.msg).toContain(HELP_GROUPS);
    expect(r.events.find((e) => e.type === 'parked')?.park?.reason).toBe('conflict');
    expect(r.releaseIssue).toHaveBeenCalledWith(ISSUE, 'parked');
    expect(r.created).toEqual([]);
    expect(r.closed).toEqual([]);
  });

  it('a missing frozen spec parks conflict at setup instead of re-planning', async () => {
    const r = await runAdoptedConflict();

    expect(r.events.find((e) => e.type === 'conflict')?.msg).toContain('failed at setup');
    expect(phases.planPhase).not.toHaveBeenCalled();
    expect(phases.buildPhase).not.toHaveBeenCalled();
    expect(r.releaseIssue).toHaveBeenCalledWith(ISSUE, 'parked');
  });

  it('a rebuilt PR that conflicts again parks conflict and opens no third PR', async () => {
    freezeSpec();
    const r = await runAdoptedConflict();

    expect(r.created.map((p) => p.head)).toEqual([NEW]);
    expect(r.lands.map((l) => [l.branch, l.deps.rebuildOnConflict])).toEqual([
      [OLD, true],
      [NEW, undefined],
    ]);
    expect(r.events.find((e) => e.type === 'conflict')?.msg).toContain(`land sync failed on ${NEW}`);
    expect(r.events.find((e) => e.type === 'parked')?.park?.reason).toBe('conflict');
  });

  it('an adopted branch that was already rebuilt parks on its conflict without a rebuild', async () => {
    freezeSpec();
    const r = await runAdoptedConflict({ branch: NEW });

    expect(r.lands.map((l) => l.deps.rebuildOnConflict)).toEqual([false]);
    expect(phases.buildPhase).not.toHaveBeenCalled();
    expect(r.created).toEqual([]);
    expect(r.events.find((e) => e.type === 'parked')?.park?.reason).toBe('conflict');
  });

  it('still lands the new PR when closing the old one fails', async () => {
    freezeSpec();
    const closeReplacedPr = async () => Promise.reject(new Error('github 502'));
    const r = await runAdoptedConflict({ conflicts: (b) => b === OLD, closeReplacedPr });

    expect(r.events.filter((e) => e.type === 'warn').map((e) => e.msg)).toContain(
      'could not close PR #123 after opening #124: github 502',
    );
    expect(r.lands.map((l) => l.branch)).toEqual([OLD, NEW]);
    expect(r.releaseIssue).toHaveBeenCalledWith(ISSUE, 'done');
  });
});

describe('land hand-off', () => {
  const land = (rebuildOnConflict?: boolean) => {
    const logs: string[] = [];
    const promise = landOpenPullRequest({
      octokit: landOctokit,
      owner: 'on-par',
      repoName: 'software-factory',
      ghRepo: REPO,
      repoRoot: '/repo',
      issue: ISSUE,
      branch: OLD,
      worktree: '/wt',
      prNumber: 123,
      log: (type) => logs.push(type),
      run: conflictingGit().run,
      pathExists: () => true,
      behindProbe: async () => false,
      rebuildOnConflict,
    });
    return {
      logs,
      err: promise.then(
        () => undefined,
        (e: unknown) => e as LandConflictError,
      ),
    };
  };

  it('hands the conflict back with what the lane needs to rebuild, and logs no park', async () => {
    const { logs, err } = land(true);
    expect((await err)?.rebuild).toEqual({
      prNumber: 123,
      branch: OLD,
      paths: [HELP_GROUPS],
      mergeStateStatus: 'DIRTY',
    });
    expect(logs).not.toContain('conflict');
  });

  it('without the opt-in it parks conflict as before', async () => {
    const { logs, err } = land();
    const e = await err;
    expect(e).toBeInstanceOf(LandConflictError);
    expect(e?.rebuild).toBeUndefined();
    expect(e?.message).toContain(`(${HELP_GROUPS})`);
    expect(e?.message).toMatch(/— parked$/);
    expect(logs).toContain('conflict');
  });
});

describe('landWithOneRebuild', () => {
  const handOff = new LandConflictError('conflict', {
    prNumber: 123,
    branch: OLD,
    paths: [HELP_GROUPS],
    mergeStateStatus: 'DIRTY',
  });
  const ops = (ship: LandRebuildOps['ship'], land: LandRebuildOps['land'] = async () => Promise.reject(handOff)) => {
    const emitted: Array<{ kind: string; msg: string }> = [];
    const o: LandRebuildOps = {
      land,
      ship,
      closeReplaced: async () => {},
      onRebuilt: () => {},
      emit: (kind, msg) => emitted.push({ kind, msg }),
    };
    return { o, emitted };
  };

  it.each([
    ['without an outcome', async () => 'branch'],
    [
      'released (file-overlap)',
      async (_r: unknown, onOutcome: Parameters<LandRebuildOps['ship']>[1]) => {
        onOutcome({ state: 'released', reason: 'file-overlap', holder: 7, file: 'x', reworkRounds: 0 });
      },
    ],
  ] as const)('parks conflict when the rebuild run ends %s with no PR', async (ended, ship) => {
    const { o, emitted } = ops(ship);
    const err = await landWithOneRebuild(ISSUE, OLD, false, o).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LandConflictError);
    expect((err as LandConflictError).rebuild).toBeUndefined();
    expect(emitted.find((e) => e.kind === 'conflict')?.msg).toContain(`failed at setup`);
    expect(emitted.find((e) => e.kind === 'conflict')?.msg).toContain(`the run ended ${ended} with no PR`);
  });

  it('rethrows a lost claim during the rebuild without parking', async () => {
    const lost = new ClaimLostError(ISSUE, 'lapsed');
    const { o, emitted } = ops(async () => Promise.reject(lost));
    await expect(landWithOneRebuild(ISSUE, OLD, false, o)).rejects.toBe(lost);
    expect(emitted.some((e) => e.kind === 'conflict')).toBe(false);
  });

  it('rethrows a land error that is not a rebuild hand-off without shipping', async () => {
    const ship = vi.fn(async () => 'never');
    const parked = new LandConflictError('parked');
    const { o } = ops(ship, async () => Promise.reject(parked));
    await expect(landWithOneRebuild(ISSUE, OLD, true, o)).rejects.toBe(parked);
    expect(ship).not.toHaveBeenCalled();
  });
});
