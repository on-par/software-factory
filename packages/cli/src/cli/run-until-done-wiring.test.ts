import { Octokit } from '@octokit/rest';
import { getFactoryPaths, loadFactoryConfig, type RunOutcome } from '@on-par/factory-core';
import { createTempDirs } from '@on-par/factory-core/testing';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { CliExitError } from './errors.js';
import { IssueSkippedError } from './index.js';
import {
  awaitingReviewState,
  findFactoryPr,
  untilDoneDepsFrom,
  type PullSummary,
  type PullsPort,
  type UntilDonePorts,
  type UntilDoneWiring,
} from './run-until-done-wiring.js';
import type { MergeResult } from './run-issue-merge.js';
import type { FeedbackRoundResult } from './respond-command.js';

const pull = (number: number, ref: string, over: Partial<PullSummary> = {}): PullSummary => ({
  number,
  state: 'open',
  merged_at: null,
  head: { ref, repo: { full_name: 'o/r' } },
  ...over,
});

const portOf = (all: PullSummary[]): PullsPort => ({
  list: async (page) => all.slice((page - 1) * 100, page * 100),
  get: async (n) => {
    const found = all.find((p) => p.number === n);
    if (!found) throw new Error(`no PR ${n}`);
    return found;
  },
});

describe('findFactoryPr', () => {
  it('prefers an open PR over a newer closed one', async () => {
    const pulls = portOf([
      pull(9, 'factory/12-x', { state: 'closed' }),
      pull(7, 'factory/12-x'),
      pull(5, 'factory/12-x', { state: 'closed', merged_at: '2026-01-01' }),
    ]);
    await expect(findFactoryPr(pulls, 'o/r', 'factory', 12)).resolves.toEqual({
      number: 7,
      branch: 'factory/12-x',
      state: 'open',
    });
  });

  it('takes the newest finished PR when none is open and maps merged_at to merged', async () => {
    const pulls = portOf([
      pull(5, 'factory/12-x', { state: 'closed' }),
      pull(8, 'factory/12-x', { state: 'closed', merged_at: '2026-01-01' }),
    ]);
    await expect(findFactoryPr(pulls, 'o/r', 'factory', 12)).resolves.toMatchObject({ number: 8, state: 'merged' });
  });

  it('ignores other issues, other branches and forks, and returns undefined when none match', async () => {
    const pulls = portOf([
      pull(1, 'factory/13-x'),
      pull(2, 'feature/12-x'),
      pull(3, 'factory/12-x', { head: { ref: 'factory/12-x', repo: { full_name: 'evil/r' } } }),
      pull(4, 'factory/12-x', { head: { ref: 'factory/12-x', repo: null } }),
    ]);
    await expect(findFactoryPr(pulls, 'o/r', 'factory', 12)).resolves.toBeUndefined();
  });

  it('pages through every page of pull requests', async () => {
    const filler = Array.from({ length: 100 }, (_v, i) => pull(1000 - i, 'feature/other'));
    const pulls = portOf([...filler, pull(3, 'factory/12-x')]);
    await expect(findFactoryPr(pulls, 'o/r', 'factory', 12)).resolves.toMatchObject({ number: 3 });
  });
});

describe('awaitingReviewState', () => {
  it('builds a minimal awaiting-review state when nothing is known', () => {
    const state = awaitingReviewState(null, 12, 7, 3, 'T');
    expect(state).toMatchObject({
      version: 1,
      prNumber: 7,
      status: 'awaiting-review',
      reviewRework: { used: 0, cap: 3 },
      updatedAt: 'T',
    });
  });

  it('keeps a known state but flips its status and drops a stale draft reason', () => {
    const known = awaitingReviewState(null, 12, 7, 3, 'T0');
    const state = awaitingReviewState(
      { ...known, status: 'awaiting-ci', draftReason: 'ci-pending', handledReviewIds: [5] },
      12,
      7,
      3,
      'T1',
    );
    expect(state).toMatchObject({ status: 'awaiting-review', handledReviewIds: [5], updatedAt: 'T1' });
    expect(state).not.toHaveProperty('draftReason');
  });
});

function setup(portOver: UntilDonePorts = {}, over: Partial<UntilDoneWiring> = {}) {
  const onOutcome = vi.fn<UntilDoneWiring['onOutcome']>();
  const recordMerge = vi.fn<UntilDoneWiring['recordMerge']>();
  const log = vi.fn<UntilDoneWiring['log']>();
  const w: UntilDoneWiring = {
    issue: 12,
    octokit: new Octokit(),
    repo: 'o/r',
    repoRoot: '/tmp/until-done-repo',
    paths: getFactoryPaths('/tmp/until-done-repo'),
    config: loadFactoryConfig(),
    branchPrefix: 'factory',
    admin: false,
    mergeTimeoutMs: 5000,
    onOutcome,
    recordMerge,
    log,
    ...over,
  };
  const pulls = portOf([pull(7, 'factory/12-x'), pull(8, 'factory/13-x', { state: 'closed' })]);
  return { w, deps: untilDoneDepsFrom(w, { pulls, ...portOver }), onOutcome, recordMerge, log };
}

const ready: RunOutcome = { state: 'ready', route: 'claude', branch: 'factory/12-x', reworkRounds: 0, prNumber: 7 };

describe('untilDoneDepsFrom', () => {
  it('looks up the PR and its state through the pulls port', async () => {
    const { deps } = setup();
    await expect(deps.findIssuePr(12)).resolves.toMatchObject({ number: 7, state: 'open' });
    await expect(deps.prState(8)).resolves.toBe('closed');
  });

  it('ship returns the last reported outcome and forwards each one', async () => {
    const ship = vi.fn<NonNullable<UntilDonePorts['ship']>>(async (_issue, _opts, ctx) => {
      ctx?.onOutcome?.(ready);
      return 'factory/12-x';
    });
    const { deps, onOutcome } = setup({ ship });
    await expect(deps.ship(12)).resolves.toEqual(ready);
    expect(onOutcome).toHaveBeenCalledWith(ready);
    expect(ship.mock.calls[0]?.[1]).toEqual({ branchPrefix: 'factory', autoRework: true, interactive: false });
  });

  it('ship swallows a failure that reported a parked outcome and logs it', async () => {
    const parked: RunOutcome = { state: 'parked', reason: 'fail' };
    const ship = vi.fn<NonNullable<UntilDonePorts['ship']>>(async (_issue, _opts, ctx) => {
      ctx?.onOutcome?.(parked);
      throw new Error('lane parked');
    });
    const { deps, log } = setup({ ship });
    await expect(deps.ship(12)).resolves.toEqual(parked);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('lane parked'));
  });

  it('ship rethrows a crash that reported no parked or escalated outcome', async () => {
    const { deps } = setup({ ship: async () => Promise.reject(new Error('build exploded')) });
    await expect(deps.ship(12)).rejects.toThrow('build exploded');
  });

  it('ship rethrows CliExitError and IssueSkippedError', async () => {
    const cli = setup({ ship: async () => Promise.reject(new CliExitError('usage', 2)) });
    await expect(cli.deps.ship(12)).rejects.toBeInstanceOf(CliExitError);
    const skipped = setup({ ship: async () => Promise.reject(new IssueSkippedError('skip', 'already-closed')) });
    await expect(skipped.deps.ship(12)).rejects.toBeInstanceOf(IssueSkippedError);
  });

  it('driveToMerge passes admin and the merge timeout and records the result', async () => {
    const result: MergeResult = { kind: 'merged', prNumber: 7, detail: 'merged' };
    const drive = vi.fn<NonNullable<UntilDonePorts['driveToMerge']>>(async () => result);
    const { deps, recordMerge } = setup({ driveToMerge: drive }, { admin: true });
    await expect(deps.driveToMerge(ready)).resolves.toEqual(result);
    expect(drive.mock.calls[0]?.[0]).toMatchObject({ issue: 12, outcome: ready, timeoutMs: 5000, admin: true });
    expect(recordMerge).toHaveBeenCalledWith(result);
  });

  it('driveToMerge omits admin by default', async () => {
    const drive = vi.fn<NonNullable<UntilDonePorts['driveToMerge']>>(async () => ({ kind: 'merged', detail: '' }));
    const { deps } = setup({ driveToMerge: drive });
    await deps.driveToMerge(ready);
    expect(drive.mock.calls[0]?.[0]).not.toHaveProperty('admin');
  });

  it('feedbackRound returns the round result and maps a CliExitError to parked', async () => {
    const result: FeedbackRoundResult = { pr: 7, issue: 12, result: 'shipped' };
    const ok = setup({ feedbackRound: async () => result });
    await expect(ok.deps.feedbackRound(7)).resolves.toEqual({ parked: false, detail: 'shipped' });
    const capped = setup({ feedbackRound: async () => Promise.reject(new CliExitError('at the cap', 1)) });
    await expect(capped.deps.feedbackRound(7)).resolves.toEqual({ parked: true, detail: 'at the cap' });
    const broken = setup({ feedbackRound: async () => Promise.reject(new Error('boom')) });
    await expect(broken.deps.feedbackRound(7)).rejects.toThrow('boom');
  });

  it('restorePrState hands the issue, branch and review-rework store to the restore', async () => {
    const restore = vi.fn<NonNullable<UntilDonePorts['restore']>>(async () => undefined);
    const { deps } = setup({ restore });
    await deps.restorePrState(12, 'factory/12-x');
    expect(restore.mock.calls[0]?.[0]).toMatchObject({
      repo: 'o/r',
      branch: 'factory/12-x',
      issueNum: 12,
      reviewReworkFile: getFactoryPaths('/tmp/until-done-repo').reviewRework,
    });
  });

  it('exposes the poll interval and sleeps through the injected seam', async () => {
    const sleep = vi.fn<NonNullable<UntilDonePorts['sleep']>>(async () => {});
    const { deps } = setup({ sleep, pollMs: 5 });
    await deps.sleep(5);
    expect(sleep).toHaveBeenCalledWith(5);
    expect(deps.pollMs).toBe(5);
  });
});

type Fetch = NonNullable<ConstructorParameters<typeof Octokit>[0]>['request'] extends infer R
  ? R extends { fetch?: infer F }
    ? F
    : never
  : never;

/** A GitHub that holds one open factory PR #7 with one review from a trusted admin. */
function fakeGitHub(reviewBody: string) {
  const posted: string[] = [];
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl: Fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const method = init?.method ?? 'GET';
    const path = url.pathname;
    if (method === 'POST' && path === '/graphql') {
      return json({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } });
    }
    if (method === 'POST' && path.endsWith('/issues/7/comments')) {
      posted.push(String(init?.body ?? ''));
      return json({ id: 99, body: '' }, 201);
    }
    if (path === '/user') return json({ id: 1, login: 'bot' });
    if (path.endsWith('/pulls/7/reviews')) {
      return json([{ id: 5, user: { login: 'alice' }, state: 'COMMENTED', body: reviewBody, html_url: 'u' }]);
    }
    if (path.endsWith('/collaborators/alice/permission')) return json({ permission: 'admin' });
    return json([]);
  };
  return { octokit: new Octokit({ request: { fetch: fetchImpl } }), posted };
}

describe('untilDoneDepsFrom against GitHub', () => {
  const dirs = createTempDirs();
  afterEach(() => dirs.cleanup());
  const root = (): string => dirs.makeSync('until-done-');

  it('uses the real clock and a real timer by default', async () => {
    const w = setup().w;
    const deps = untilDoneDepsFrom(w, { pulls: portOf([]) });
    await expect(deps.sleep(1)).resolves.toBeUndefined();
    expect(Math.abs(deps.now() - Date.now())).toBeLessThan(1000);
    expect(deps.pollMs).toBe(60_000);
  });

  it('looks pull requests up through octokit when no pulls port is injected', async () => {
    const pull = {
      number: 7,
      state: 'open',
      merged_at: null,
      head: { ref: 'factory/12-x', repo: { full_name: 'o/r' } },
    };
    const octokit = new Octokit({
      request: {
        fetch: async () =>
          new Response(JSON.stringify([pull]), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      },
    });
    const w: UntilDoneWiring = { ...setup().w, octokit };
    const deps = untilDoneDepsFrom(w);
    await expect(deps.findIssuePr(12)).resolves.toMatchObject({ number: 7, state: 'open' });
  });

  it('pendingFeedback counts trusted unhandled feedback', async () => {
    const { octokit } = fakeGitHub('please rename this');
    const { deps } = setup({}, { octokit, repoRoot: root(), paths: getFactoryPaths(root()) });
    await expect(deps.pendingFeedback(7)).resolves.toBe(1);
  });

  it('saveAwaitingReview posts a minimal awaiting-review state to the PR', async () => {
    const { octokit, posted } = fakeGitHub('');
    const { deps } = setup({}, { octokit, paths: getFactoryPaths(root()) });
    await deps.saveAwaitingReview(12, 7);
    expect(posted).toHaveLength(1);
    const encoded = /run-state-data (\S+)/.exec(posted[0] ?? '')?.[1] ?? '';
    expect(JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'))).toMatchObject({
      status: 'awaiting-review',
      prNumber: 7,
    });
  });

  it('saveAwaitingReview logs and swallows a GitHub failure', async () => {
    const failing = new Octokit({
      request: { fetch: async () => new Response('{"message":"down"}', { status: 500 }) },
    });
    const paths = getFactoryPaths(root());
    const { deps } = setup({}, { octokit: failing, paths });
    await expect(deps.saveAwaitingReview(12, 7)).resolves.toBeUndefined();
  });
});
