import type { Octokit } from '@octokit/rest';
import { getFactoryPaths, type FactoryConfig } from '@on-par/factory-core';
import { createFileReviewReworkStore } from '@on-par/factory-core/internal';
import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CliExitError } from './errors.js';
import { cmdRespond, type RespondDeps } from './respond-command.js';

const tmp = createTempDirs();
afterEach(async () => {
  await tmp.cleanup();
});

type Pull = { state: string; head: { ref: string; repo: { full_name: string } | null } };
const open: Pull = { state: 'open', head: { ref: 'factory/42-fix-it', repo: { full_name: 'o/r' } } };

async function setup(pull: Pull = open, config: Partial<FactoryConfig> = {}) {
  const repoRoot = await tmp.make('respond-');
  const out: string[] = [];
  const octokit = Object.assign({} as Octokit, {
    rest: {
      pulls: { get: vi.fn(async () => ({ data: pull })) },
      issues: { listLabelsOnIssue: vi.fn(async () => ({ data: [{ name: 'factory:lane:bugfix' }] })) },
    },
  });
  const shipIssue = vi.fn<RespondDeps['shipIssue']>(async () => 'shipped');
  const parkAtCap = vi.fn<RespondDeps['parkAtCap']>(async () => {});
  const deps: RespondDeps = {
    getRepoRoot: async () => repoRoot,
    getGitHubRepo: async () => 'o/r',
    getOctokit: () => octokit,
    loadConfig: () => config as FactoryConfig,
    shipIssue,
    parkAtCap,
    now: () => new Date('2026-01-02T00:00:00.000Z'),
    out: (l) => out.push(l),
  };
  return { deps, out, shipIssue, parkAtCap, repoRoot };
}

describe('cmdRespond', () => {
  it("respond starts a feedback round for the PR's issue", async () => {
    const { deps, shipIssue, out } = await setup();
    await cmdRespond('#7', {}, deps);
    expect(shipIssue).toHaveBeenCalledTimes(1);
    const [issue, opts, ctx] = shipIssue.mock.calls[0] ?? [];
    expect(issue).toBe(42);
    expect(opts).toMatchObject({ branchPrefix: 'factory', autoRework: true, interactive: false });
    expect(ctx).toMatchObject({ ghRepo: 'o/r', feedbackRound: { prNumber: 7 } });
    expect(out[0]).toContain('feedback round on PR #7 (issue #42): shipped');
  });

  it('records the round against the cap before shipping and prints JSON on request', async () => {
    const { deps, shipIssue, out, repoRoot } = await setup();
    const reviewRework = getFactoryPaths(repoRoot).reviewRework;
    shipIssue.mockImplementation(async () => {
      expect(createFileReviewReworkStore(reviewRework).list()).toMatchObject([
        {
          reviewId: 70001,
          source: 'feedback',
          pr: 7,
          issue: 42,
          lane: 'bugfix',
          startedAt: '2026-01-02T00:00:00.000Z',
        },
      ]);
      return 'ok';
    });
    await cmdRespond('7', { json: true }, deps);
    expect(JSON.parse(out[0] ?? '{}')).toEqual({ pr: 7, issue: 42, result: 'ok' });
  });

  it.each([
    ['closed', { ...open, state: 'closed' }],
    ['not a factory branch', { ...open, head: { ref: 'feature/x', repo: { full_name: 'o/r' } } }],
    ['from a fork', { ...open, head: { ref: 'factory/42-x', repo: { full_name: 'evil/r' } } }],
    ['from a deleted fork', { ...open, head: { ref: 'factory/42-x', repo: null } }],
  ])('rejects a PR that is %s without running', async (_name, pull) => {
    const { deps, shipIssue } = await setup(pull);
    await expect(cmdRespond('7', {}, deps)).rejects.toMatchObject({ code: 1 });
    expect(shipIssue).not.toHaveBeenCalled();
  });

  it('rejects a non-numeric PR argument', async () => {
    const { deps } = await setup();
    await expect(cmdRespond('abc', {}, deps)).rejects.toBeInstanceOf(CliExitError);
  });

  it('parks at the review-rework cap without running', async () => {
    const { deps, shipIssue, parkAtCap } = await setup(open, { queue: { max_review_rework_runs: 1 } } as never);
    const paths = getFactoryPaths(await deps.getRepoRoot());
    createFileReviewReworkStore(paths.reviewRework).record({
      reviewId: 1,
      pr: 7,
      issue: 42,
      lane: 'bugfix',
      reviewer: 'bob',
      queuedAt: '2026-01-01T00:00:00.000Z',
      startedAt: '2026-01-01T00:00:00.000Z',
    });
    await expect(cmdRespond('7', {}, deps)).rejects.toMatchObject({ code: 1 });
    expect(shipIssue).not.toHaveBeenCalled();
    expect(parkAtCap).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'feedback',
        cap: 1,
        count: 1,
        pr: 7,
        lane: 'bugfix',
        branch: 'factory/42-fix-it',
      }),
    );
  });
});
