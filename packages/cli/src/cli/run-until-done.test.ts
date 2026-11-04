import type { Octokit } from '@octokit/rest';
import type { RunOutcome } from '@on-par/factory-core';
import type { PrRunState } from '@on-par/factory-core/internal';
import { describe, expect, it, vi } from 'vitest';

import type { CliExitError } from './errors.js';
import type { MergeResult } from './run-issue-merge.js';
import {
  exitForUntilDone,
  findFactoryPrForIssue,
  parseWaitMode,
  driveUntilDone,
  untilDoneCaps,
  untilDoneDepsFrom,
  runIssueUntilDone,
  UNTIL_DONE_EXIT,
  validateUntilDoneFlags,
  type FactoryPrRef,
  type UntilDoneDeps,
  type UntilDoneInput,
} from './run-until-done.js';

const openPr: FactoryPrRef = { number: 7, headRef: 'factory/42-x', state: 'open', merged: false };
const input: UntilDoneInput = {
  issue: 42,
  ghRepo: 'o/r',
  wait: 'stay',
  maxWaitMs: 1000,
  autoMerge: false,
  admin: false,
  pollMs: 100,
  reviewReworkCap: 3,
  checkReworkCap: 2,
};
const shipped: RunOutcome = { state: 'shipped', route: 'claude', branch: 'factory/42-x', reworkRounds: 0, prNumber: 7 };

function setup(over: Partial<UntilDoneDeps> = {}) {
  let t = 0;
  const deps = {
    findPr: vi.fn(async () => openPr as FactoryPrRef | undefined),
    getPr: vi.fn(async () => openPr),
    ship: vi.fn(async () => shipped as RunOutcome | undefined),
    collectFeedback: vi.fn(async () => []),
    respond: vi.fn<UntilDoneDeps['respond']>(async () => ({ issue: 42, result: 'shipped' })),
    driveMerge: vi.fn<UntilDoneDeps['driveMerge']>(async () => ({ kind: 'merged', detail: '' }) as MergeResult),
    loadState: vi.fn(async () => undefined as PrRunState | undefined),
    saveState: vi.fn(async () => {}),
    now: () => t,
    sleep: vi.fn(async (ms: number) => {
      t += ms;
    }),
    log: vi.fn(),
    ...over,
  } satisfies UntilDoneDeps;
  return deps;
}

describe('runIssueUntilDone', () => {
  it('auto-merge ships then merges and returns merged', async () => {
    const deps = setup({ findPr: vi.fn(async () => undefined) });
    const r = await runIssueUntilDone({ ...input, autoMerge: true }, deps);
    expect(r).toMatchObject({ outcome: 'merged', prNumber: 7 });
    expect(deps.ship).toHaveBeenCalledTimes(1);
    expect(deps.driveMerge).toHaveBeenCalledWith(openPr, expect.any(Number));
  });

  it('stay runs one feedback round per new feedback and returns merged when a human merges', async () => {
    const item = { kind: 'comment', id: 1, author: 'bob', body: 'fix', url: '' } as const;
    const collect = vi.fn().mockResolvedValueOnce([item]).mockResolvedValue([]);
    const getPr = vi
      .fn<UntilDoneDeps['getPr']>()
      .mockResolvedValueOnce(openPr)
      .mockResolvedValueOnce(openPr)
      .mockResolvedValue({ ...openPr, state: 'closed', merged: true });
    const deps = setup({ collectFeedback: collect, getPr });
    const r = await runIssueUntilDone(input, deps);
    expect(r.outcome).toBe('merged');
    expect(deps.respond).toHaveBeenCalledTimes(1);
    expect(deps.ship).not.toHaveBeenCalled();
  });

  it('stay returns closed when the PR is closed', async () => {
    const deps = setup({ getPr: vi.fn(async () => ({ ...openPr, state: 'closed' as const })) });
    expect((await runIssueUntilDone(input, deps)).outcome).toBe('closed');
  });

  it('an already merged or closed PR short-circuits before shipping', async () => {
    const merged = setup({ findPr: vi.fn(async () => ({ ...openPr, state: 'closed' as const, merged: true })) });
    expect((await runIssueUntilDone(input, merged)).outcome).toBe('merged');
    const closed = setup({ findPr: vi.fn(async () => ({ ...openPr, state: 'closed' as const })) });
    expect((await runIssueUntilDone(input, closed)).outcome).toBe('closed');
    expect(closed.ship).not.toHaveBeenCalled();
  });

  it('stay returns awaiting-review after max-wait', async () => {
    const deps = setup();
    const r = await runIssueUntilDone(input, deps);
    expect(r).toMatchObject({ outcome: 'awaiting-review', reason: 'max-wait' });
    expect(deps.sleep).toHaveBeenCalled();
    expect(deps.saveState).not.toHaveBeenCalled();
  });

  it('exit with no unhandled feedback saves awaiting-review state and returns awaiting-review', async () => {
    const deps = setup();
    const r = await runIssueUntilDone({ ...input, wait: 'exit' }, deps);
    expect(r.outcome).toBe('awaiting-review');
    expect(deps.saveState).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ status: 'awaiting-review', prNumber: 7, reviewRework: { used: 0, cap: 3 } }),
    );
  });

  it('exit keeps the loaded state and logs a failed save', async () => {
    const loaded = { version: 1, key: 'issue-42', prNumber: 7, reviewRework: { used: 2, cap: 3 } } as never;
    const deps = setup({
      loadState: vi.fn(async () => loaded),
      saveState: vi.fn(async () => {
        throw new Error('nope');
      }),
    });
    const r = await runIssueUntilDone({ ...input, wait: 'exit' }, deps);
    expect(r.outcome).toBe('awaiting-review');
    expect(deps.log).toHaveBeenCalledWith('pr_state_failed', expect.stringContaining('nope'));
  });

  it('re-run with an existing open PR and no new feedback never calls shipIssue', async () => {
    const deps = setup();
    await runIssueUntilDone({ ...input, wait: 'exit' }, deps);
    expect(deps.ship).not.toHaveBeenCalled();
    expect(deps.respond).not.toHaveBeenCalled();
  });

  it('re-run with new trusted feedback runs one round on the existing PR and skips handled items', async () => {
    const item = { kind: 'comment', id: 9, author: 'bob', body: 'more', url: '' } as const;
    const deps = setup({
      collectFeedback: vi.fn().mockResolvedValueOnce([item]).mockResolvedValue([]),
      loadState: vi.fn(async () => ({ reviewRework: { used: 2, cap: 3 } }) as never),
    });
    const r = await runIssueUntilDone({ ...input, wait: 'exit' }, deps);
    expect(deps.respond).toHaveBeenCalledTimes(1);
    expect(deps.respond).toHaveBeenCalledWith(7, 2);
    expect(deps.ship).not.toHaveBeenCalled();
    expect(r.outcome).toBe('awaiting-review');
  });

  it('a gate hold from driveToMerge is waiting on a human, not merged', async () => {
    const deps = setup({
      driveMerge: vi.fn(async (): Promise<MergeResult> => ({ kind: 'held', gate: 'risk-tier', detail: 'held' })),
    });
    const r = await runIssueUntilDone({ ...input, autoMerge: true, wait: 'exit' }, deps);
    expect(r).toMatchObject({ outcome: 'awaiting-review', reason: 'held by risk-tier' });
  });

  it('timed-out waits on a human; ci-failed and land-failed park', async () => {
    const timed = setup({ driveMerge: vi.fn(async (): Promise<MergeResult> => ({ kind: 'timed-out', detail: 't' })) });
    expect((await runIssueUntilDone({ ...input, autoMerge: true, wait: 'exit' }, timed)).outcome).toBe(
      'awaiting-review',
    );
    for (const kind of ['ci-failed', 'land-failed', 'failed-before-pr'] as const) {
      const deps = setup({ driveMerge: vi.fn(async () => ({ kind, detail: 'boom' })) });
      expect(await runIssueUntilDone({ ...input, autoMerge: true }, deps)).toMatchObject({
        outcome: 'parked',
        reason: 'boom',
      });
    }
  });

  it('admin from the merge policy is passed to driveToMerge', async () => {
    const drive = vi.fn<UntilDoneDeps['driveMerge']>(async () => ({ kind: 'merged', detail: '' }));
    await runIssueUntilDone({ ...input, autoMerge: true, admin: true }, setup({ driveMerge: drive }));
    // The admin flag rides in the production wiring; the driver hands over the PR and the remaining wait.
    expect(drive).toHaveBeenCalledWith(openPr, 1000);
  });

  it('auto-merge off never calls driveToMerge', async () => {
    const deps = setup();
    await runIssueUntilDone({ ...input, wait: 'exit' }, deps);
    expect(deps.driveMerge).not.toHaveBeenCalled();
  });

  it('a parked ship outcome returns parked', async () => {
    const parked: RunOutcome = { state: 'parked', reason: 'ci-failed', prNumber: 7 } as never;
    const deps = setup({ findPr: vi.fn(async () => undefined), ship: vi.fn(async () => parked) });
    expect(await runIssueUntilDone(input, deps)).toMatchObject({ outcome: 'parked', reason: 'ci-failed' });
  });

  it('parks when ship has no outcome, throws, or opens no PR', async () => {
    const none = setup({ findPr: vi.fn(async () => undefined), ship: vi.fn(async () => undefined) });
    expect((await runIssueUntilDone(input, none)).outcome).toBe('parked');
    const boom = setup({
      findPr: vi.fn(async () => undefined),
      ship: vi.fn(async () => {
        throw new Error('exploded');
      }),
    });
    expect(await runIssueUntilDone(input, boom)).toMatchObject({ outcome: 'parked', reason: 'exploded' });
    const noPr: RunOutcome = { state: 'ready', route: 'claude', branch: 'b', reworkRounds: 0 };
    const nopr = setup({ findPr: vi.fn(async () => undefined), ship: vi.fn(async () => noPr) });
    expect(await runIssueUntilDone(input, nopr)).toMatchObject({ outcome: 'parked', reason: 'no PR opened' });
  });

  it('the review-rework cap returns parked', async () => {
    const item = { kind: 'comment', id: 1, author: 'bob', body: 'x', url: '' } as const;
    const deps = setup({
      collectFeedback: vi.fn(async () => [item]),
      respond: vi.fn(async () => ({ parked: true as const, issue: 42, count: 3, cap: 3 })),
    });
    expect(await runIssueUntilDone(input, deps)).toMatchObject({ outcome: 'parked', reason: 'review-rework-cap' });
  });
});

describe('exit codes and flags', () => {
  it('UNTIL_DONE_EXIT codes are distinct', () => {
    const codes = Object.values(UNTIL_DONE_EXIT);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('exitForUntilDone returns without throwing for merged', () => {
    const out = vi.fn();
    expect(() =>
      exitForUntilDone({ outcome: 'merged', prNumber: 7, reason: 'merged' }, { issue: 42, out }),
    ).not.toThrow();
    expect(out).toHaveBeenCalledTimes(1);
  });

  it('exitForUntilDone throws exit code 15 for awaiting-review, 1 parked, 14 closed', () => {
    const code = (outcome: 'awaiting-review' | 'parked' | 'closed') => {
      try {
        exitForUntilDone({ outcome, reason: 'r' }, { issue: 42, out: vi.fn() });
      } catch (err) {
        return (err as CliExitError).code;
      }
      return undefined;
    };
    expect([code('awaiting-review'), code('parked'), code('closed')]).toEqual([15, 1, 14]);
  });

  it('exitForUntilDone prints one JSON object with outcome awaiting-review', () => {
    const lines: string[] = [];
    let thrown: CliExitError | undefined;
    try {
      exitForUntilDone(
        { outcome: 'awaiting-review', prNumber: 7, reason: 'max-wait' },
        { json: true, issue: 42, out: (l) => lines.push(l) },
      );
    } catch (err) {
      thrown = err as CliExitError;
    }
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toEqual({
      schemaVersion: 1,
      issue: 42,
      outcome: 'awaiting-review',
      prNumber: 7,
      reason: 'max-wait',
      exitCode: 15,
    });
    expect(thrown).toMatchObject({ code: 15, message: '' });
  });

  it('exitForUntilDone --json merged prints and returns', () => {
    const out = vi.fn();
    exitForUntilDone({ outcome: 'merged', reason: 'merged' }, { json: true, issue: 1, out });
    expect(JSON.parse(out.mock.calls[0]?.[0] as string)).toMatchObject({ prNumber: null, exitCode: 0 });
  });

  it('parseWaitMode defaults to stay', () => {
    expect(parseWaitMode(undefined)).toBe('stay');
    expect(parseWaitMode('exit')).toBe('exit');
  });

  it('parseWaitMode rejects an unknown mode with exit 2', () => {
    expect(() => parseWaitMode('later')).toThrow(expect.objectContaining({ code: 2 }));
  });

  it('validateUntilDoneFlags conflicts with --merge, --no-pr, --stack, --workspace, and --wait without --until-done', () => {
    const on = { untilDone: true };
    for (const bad of [{ merge: true }, { pr: false }, { stack: true }, { workspace: 'w' }, { maxWait: 'x' }]) {
      expect(() => validateUntilDoneFlags({ ...on, ...bad })).toThrow(expect.objectContaining({ code: 2 }));
    }
    expect(() => validateUntilDoneFlags({ wait: 'exit' })).toThrow(expect.objectContaining({ code: 2 }));
    expect(() => validateUntilDoneFlags({ maxWait: '5m' })).toThrow(expect.objectContaining({ code: 2 }));
    expect(validateUntilDoneFlags({})).toBeUndefined();
    expect(validateUntilDoneFlags({ ...on, wait: 'exit', maxWait: '2h' })).toEqual({
      wait: 'exit',
      maxWaitMs: 7_200_000,
    });
    expect(validateUntilDoneFlags(on)).toEqual({ wait: 'stay', maxWaitMs: undefined });
  });
});

describe('findFactoryPrForIssue', () => {
  const pull = (
    n: number,
    ref: string,
    repo: string | undefined,
    over: Partial<{ state: string; merged_at: string | null }> = {},
  ) => ({
    number: n,
    state: 'open',
    merged_at: null,
    head: { ref, repo: repo ? { full_name: repo } : null },
    ...over,
  });

  it('picks a same-repo factory branch, ignores forks, and maps merged_at', async () => {
    const list = vi.fn(async () => ({
      data: [
        pull(9, 'factory/42-x', 'fork/r'),
        pull(8, 'factory/41-y', 'o/r'),
        pull(7, 'factory/42-x', 'o/r', { state: 'closed', merged_at: '2026-01-01T00:00:00Z' }),
      ],
    }));
    const octokit = Object.assign({} as Octokit, { rest: { pulls: { list } } });
    expect(await findFactoryPrForIssue(octokit, 'o/r', 42, 'factory')).toEqual({
      number: 7,
      headRef: 'factory/42-x',
      state: 'closed',
      merged: true,
    });
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('pages through full pages and returns undefined when nothing matches', async () => {
    const full = Array.from({ length: 100 }, (_, i) => pull(i + 1, 'feature/x', 'o/r'));
    const list = vi.fn(async () => ({ data: full }));
    const octokit = Object.assign({} as Octokit, { rest: { pulls: { list } } });
    expect(await findFactoryPrForIssue(octokit, 'o/r', 42, 'factory')).toBeUndefined();
    expect(list).toHaveBeenCalledTimes(3);
  });
});

describe('untilDoneDepsFrom', () => {
  function wiring(admin: boolean) {
    const drive = vi.fn<(input: unknown) => Promise<MergeResult>>(async () => ({ kind: 'merged', detail: '' }));
    const respond = vi.fn(async () => ({ issue: 42, result: 'shipped' }));
    const pulls = {
      get: vi.fn(async () => ({ data: { number: 7, state: 'open', merged_at: null, head: { ref: 'factory/42-x' } } })),
    };
    const octokit = Object.assign({} as Octokit, { rest: { pulls } });
    const deps = untilDoneDepsFrom({
      octokit,
      ghRepo: 'o/r',
      issue: 42,
      branchPrefix: 'factory',
      config: {} as never,
      admin,
      ship: async (onOutcome) => onOutcome(shipped),
      drive,
      respond,
      log: vi.fn(),
    });
    return { deps, drive, respond };
  }

  it('passes admin and a synthesized ready outcome to driveToMerge', async () => {
    const { deps, drive } = wiring(true);
    await deps.driveMerge(openPr, 5000);
    expect(drive).toHaveBeenCalledWith({
      issue: 42,
      outcome: expect.objectContaining({ state: 'ready', branch: 'factory/42-x', prNumber: 7 }),
      timeoutMs: 5000,
      admin: true,
    });
  });

  it('omits admin when the policy has none, maps getPr, captures the ship outcome and respects the lock', async () => {
    const { deps, drive, respond } = wiring(false);
    await deps.driveMerge(openPr, 1);
    expect(drive.mock.calls[0]?.[0]).not.toHaveProperty('admin');
    expect(await deps.getPr(7)).toEqual(openPr);
    expect(await deps.ship()).toEqual(shipped);
    await deps.respond(7, 2);
    expect(respond).toHaveBeenCalledWith(7, { minUsed: 2, lock: false });
  });

  it('untilDoneCaps reads the review-rework cap from config', () => {
    expect(untilDoneCaps({ queue: { max_review_rework_runs: 4 } } as never).reviewReworkCap).toBe(4);
  });
});

describe('production wiring over a fake GitHub', () => {
  const fullState: PrRunState = {
    version: 1,
    key: 'issue-42' as never,
    prNumber: 7,
    status: 'awaiting-review',
    spec: { sha256: '', summary: '' },
    checkRework: { used: 0, cap: 2 },
    reviewRework: { used: 0, cap: 3 },
    handledReviewIds: [],
    handledCommentIds: [],
    rounds: [],
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const comments: { id: number; user: { id: number }; body: string }[] = [];
  const created: string[] = [];
  const rest = {
    pulls: {
      get: vi.fn(async () => ({ data: { number: 7, state: 'open', merged_at: null, head: { ref: 'factory/42-x' } } })),
      list: vi.fn(async () => ({
        data: [
          {
            number: 7,
            state: 'closed',
            merged_at: 'x' as string | null,
            head: { ref: 'factory/42-x', repo: { full_name: 'o/r' } },
          },
        ],
      })),
      listReviews: vi.fn(async () => ({ data: [] })),
      listReviewComments: vi.fn(async () => ({ data: [] })),
    },
    issues: {
      listComments: vi.fn(async () => ({ data: comments })),
      createComment: vi.fn(async (a: { body: string }) => {
        created.push(a.body);
        return { data: { id: 99 } };
      }),
      updateComment: vi.fn(async () => ({ data: {} })),
    },
    users: { getAuthenticated: vi.fn(async () => ({ data: { id: 1, login: 'bot' } })) },
  };
  const octokit = Object.assign({} as Octokit, {
    rest,
    paginate: async (fn: (a: unknown) => Promise<{ data: unknown[] }>, a: unknown) => (await fn(a)).data,
    graphql: async () => ({ repository: { pullRequest: { reviewThreads: { nodes: [] } } } }),
  });
  const wired = () =>
    untilDoneDepsFrom({
      octokit,
      ghRepo: 'o/r',
      issue: 42,
      branchPrefix: 'factory',
      config: {} as never,
      admin: false,
      ship: async () => {
        throw new Error('before outcome');
      },
      drive: async () => ({ kind: 'merged', detail: '' }),
      respond: async () => ({ issue: 42, result: 'x' }),
      log: vi.fn(),
    });

  it('finds the PR, reads no feedback or state, saves the state comment, rethrows a ship failure', async () => {
    const deps = wired();
    expect(await deps.findPr()).toMatchObject({ number: 7, merged: true });
    expect(await deps.collectFeedback(7)).toEqual([]);
    expect(await deps.loadState(7)).toBeUndefined();
    await deps.saveState(7, fullState);
    expect(created).toHaveLength(1);
    await expect(deps.ship()).rejects.toThrow('before outcome');
    expect(deps.now()).toBeGreaterThan(0);
    await deps.sleep(1);
  });

  it('driveUntilDone prints and returns for a merged PR and exits 14 for a closed one', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const base = {
      wait: 'exit' as const,
      maxWaitMs: 1000,
      issue: 42,
      ghRepo: 'o/r',
      repoRoot: '/r',
      paths: {} as never,
      branchPrefix: 'factory',
      config: { merge: {} } as never,
      autoMerge: undefined,
      admin: true,
      json: true,
      octokit,
      ship: async () => {},
    };
    await driveUntilDone(base);
    expect(JSON.parse(log.mock.calls[0]?.[0] as string)).toMatchObject({ outcome: 'merged', exitCode: 0 });
    rest.pulls.list.mockResolvedValueOnce({
      data: [
        { number: 7, state: 'closed', merged_at: null, head: { ref: 'factory/42-x', repo: { full_name: 'o/r' } } },
      ],
    });
    await expect(driveUntilDone({ ...base, json: undefined, maxWaitMs: undefined })).rejects.toMatchObject({
      code: 14,
    });
    log.mockRestore();
  });
});
