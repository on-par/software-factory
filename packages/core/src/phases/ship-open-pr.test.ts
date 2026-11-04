import { exec as execCb } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { Octokit } from '@octokit/rest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ModelRouter } from '../router/index.js';
import { StubModelExecutor } from '../router/stub.js';
import { asPhaseOctokit, createSimOctokit } from '../fakes/octokit.js';
import {
  commitAll,
  makeStubModelsConfig,
  makeStubRoutesConfig,
  PipelineTestKit,
  specContentFor,
} from '../test-support/index.js';
import { branchFor, setupWorktree } from '../utils/index.js';
import { buildPhase } from './build.js';
import { planPhase } from './plan.js';
import { findOpenPR, shipPhase } from './ship.js';
import { toWorkKey, workKeyFromIssue } from '../work/work-key.js';
import { openOrFindPr } from './ship-open-pr.js';
import type { ShipPhaseOptions } from './ship-options.js';

const exec = promisify(execCb);
const owner = 'on-par';
const repoName = 'software-factory';
const repo = `${owner}/${repoName}`;
const issue = 3099;

const kit = new PipelineTestKit();

afterEach(() => kit.cleanup());

describe('ship on an issue with an open factory PR (#3099)', () => {
  it(
    'bases the worktree on the open PR branch before any model call and ships fast-forward to the same PR',
    { timeout: 120_000 },
    async () => {
      const title = 'Open PR rerun';
      const { origin, repoRoot } = await kit.makeThrowawayRepo();
      const branch = branchFor(workKeyFromIssue(issue), title);
      const worktree = kit.trackWorktree(repoRoot, issue);
      const specPath = await kit.makeSpecPath(issue);

      // An earlier run's PR branch: a commit on origin/<branch> that main does not have.
      await writeFile(join(repoRoot, 'earlier.txt'), 'earlier run\n');
      await commitAll(repoRoot, 'feat: earlier run');
      await exec(`git -C '${repoRoot}' push origin HEAD:refs/heads/'${branch}'`);
      await exec(`git -C '${repoRoot}' reset --hard HEAD~1`);
      const { stdout: prShaOut } = await exec(`git -C '${origin}' rev-parse refs/heads/'${branch}'`);
      const prSha = prShaOut.trim();

      const prStep = { response: { data: [{ number: 2, head: { ref: branch } }] } };
      const { octokit, calls } = createSimOctokit({
        titles: { [issue]: title },
        endpoints: { 'pulls.list': Array.from({ length: 6 }, () => prStep) },
      });
      const phaseOctokit = asPhaseOctokit(octokit);
      const events: Array<[string, string]> = [];
      const log = (type: string, msg: string) => events.push([type, msg]);
      const stub = new StubModelExecutor({
        scripts: {
          // PLAN re-prompts for a missing design block, so script every attempt.
          plan: Array.from({ length: 3 }, () => ({ output: specContentFor(issue) })),
          build_claude: [
            {
              output: 'built',
              effect: async (ctx) => {
                await writeFile(join(ctx.worktree, 'feature.txt'), 'continued\n');
                await commitAll(ctx.worktree, 'feat: stub work');
              },
            },
          ],
        },
      });
      const router = new ModelRouter(makeStubModelsConfig(), makeStubRoutesConfig(), false, stub);

      const result = await setupWorktree(repoRoot, branch, worktree, undefined, undefined, log, {
        findOpenPr: (br) => findOpenPR(phaseOctokit, owner, repoName, br),
      });

      // The decision is made before any model call.
      expect(stub.calls).toHaveLength(0);
      expect(result.base).toBe(`origin/${branch}`);
      expect(result.remoteBranch).toEqual({ sha: prSha, prNumber: 2 });
      const { stdout: head } = await exec(`git -C '${worktree}' rev-parse HEAD`);
      expect(head.trim()).toBe(prSha);

      const plan = await planPhase({
        issue: workKeyFromIssue(issue),
        repo,
        worktree,
        specPath,
        router,
        constitution: null,
        octokit: phaseOctokit,
        log,
      });
      expect(plan.ok).toBe(true);
      const build = await buildPhase({
        issue: workKeyFromIssue(issue),
        repo,
        worktree,
        specPath,
        branch,
        route: plan.route,
        router,
        constitution: null,
        log,
      });
      expect(build.ok).toBe(true);
      expect(stub.calls[0]?.task).toBe('plan');

      const ship = await shipPhase({
        issue: workKeyFromIssue(issue),
        repo,
        worktree,
        branch,
        octokit: phaseOctokit,
        watchCI: false,
        log,
      });

      expect(ship.ok).toBe(true);
      expect(ship.prNumber).toBe(2);
      expect(calls.some(([name]) => name === 'pulls.create')).toBe(false);
      expect(events.some(([, msg]) => msg.includes('has diverged'))).toBe(false);
      const { stdout: wtHead } = await exec(`git -C '${worktree}' rev-parse HEAD`);
      const { stdout: remoteHead } = await exec(`git -C '${origin}' rev-parse refs/heads/'${branch}'`);
      expect(remoteHead.trim()).toBe(wtHead.trim());
      await expect(
        exec(`git -C '${origin}' merge-base --is-ancestor ${prSha} ${remoteHead.trim()}`),
      ).resolves.toBeTruthy();
    },
  );
});

describe('openOrFindPr trailers and references (#3894)', () => {
  const LINEAR = { key: toWorkKey('ON-12'), title: 'Add X' };

  async function open(extra: Partial<ShipPhaseOptions>, ticket: typeof LINEAR | undefined) {
    const create = vi.fn(async (_args: { title: string; body: string }) => ({ data: { number: 5 } }));
    const get = vi.fn(async () => ({ data: { title: 'GitHub title' } }));
    const octokit = Object.assign({} as Octokit, { rest: { pulls: { create }, issues: { get } } });
    const opts = {
      issue: workKeyFromIssue(123),
      repo,
      worktree: '/tmp/none',
      branch: 'factory/x',
      octokit,
      log: () => {},
      ...extra,
    } as ShipPhaseOptions;
    const result = await openOrFindPr({
      opts,
      inlineWork: undefined,
      ticket,
      stack: undefined,
      base: 'main',
      owner,
      repoName,
      walkthrough: { walkthrough: async () => undefined, counts: async () => 'unavailable' as const },
    });
    expect(result).toEqual({ prNumber: 5 });
    return { args: create.mock.calls[0][0], get };
  }

  it('a Linear run on its final slice opens a PR with Fixes ON-12 and no Closes #', async () => {
    const { args } = await open({}, LINEAR);
    expect(args.body).toContain('Fixes ON-12');
    expect(args.body).not.toContain('Closes #');
  });

  it('a Linear run on slice 1 of 2 opens a PR with Part of ON-12 and no closing keyword', async () => {
    const { args } = await open({ slice: { index: 1, count: 2 } }, LINEAR);
    expect(args.body).toContain('Part of ON-12');
    expect(args.body).not.toMatch(/\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\b/i);
    expect(args.title).toBe('Add X — slice 1/2 (ON-12)');
  });

  it('a Linear run titles the PR and summary with ON-12 without reading a GitHub issue', async () => {
    const { args, get } = await open({}, LINEAR);
    expect(args.title).toBe('Add X (ON-12)');
    expect(args.body).toContain('Implements ON-12.');
    expect(get).not.toHaveBeenCalled();
  });

  it('a GitHub run keeps Closes #123 and the issue title', async () => {
    const { args } = await open({}, undefined);
    expect(args.title).toBe('GitHub title (#123)');
    expect(args.body).toContain('Implements #123.');
    expect(args.body).toContain('Closes #123');
  });
});
