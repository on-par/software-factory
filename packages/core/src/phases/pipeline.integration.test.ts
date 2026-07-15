import { exec as execCb } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { ModelRouter } from '../router/index.js';
import { StubModelExecutor } from '../router/stub.js';
import { branchFor, setupWorktree } from '../utils/index.js';
import {
  commitAll,
  makeFakeOctokit,
  makeStubModelsConfig,
  makeStubRoutesConfig,
  PipelineTestKit,
  specContentFor,
} from '../test-support/index.js';
import { buildPhase } from './build.js';
import { checkPhase } from './check.js';
import { planPhase } from './plan.js';
import { shipPhase } from './ship.js';

const exec = promisify(execCb);
const repo = 'on-par/software-factory';
const issue = 34;

const kit = new PipelineTestKit();

afterEach(() => kit.cleanup());

describe('pipeline integration', () => {
  it('green path: PLAN→BUILD→CHECK→SHIP creates a ready PR', { timeout: 120_000 }, async () => {
    const title = 'Full pipeline green path';
    const { origin, repoRoot } = await kit.makeThrowawayRepo();
    const worktree = kit.trackWorktree(repoRoot, issue);
    const branch = branchFor(issue, title);
    const specPath = await kit.makeSpecPath(issue);
    const { octokit, calls } = makeFakeOctokit({ [issue]: title });
    const events: Array<[string, string]> = [];
    const log = (type: string, msg: string) => events.push([type, msg]);
    const stub = new StubModelExecutor({
      scripts: {
        plan: [{ output: specContentFor(issue) }],
        build_claude: [
          {
            output: 'built',
            effect: async (ctx) => {
              await writeFile(join(ctx.worktree, 'feature.txt'), 'green path\n');
              await commitAll(ctx.worktree, 'feat: stub work');
            },
          },
        ],
      },
    });
    const router = new ModelRouter(makeStubModelsConfig(), makeStubRoutesConfig(), false, stub);
    const constitution = null;

    const plan = await planPhase({
      issue,
      repo,
      worktree,
      specPath,
      router,
      constitution,
      octokit: octokit as any,
      log,
    });
    expect(plan.ok).toBe(true);
    expect(plan.route).toBe('claude');

    await setupWorktree(repoRoot, branch, worktree);

    const build = await buildPhase({
      issue,
      repo,
      worktree,
      specPath,
      branch,
      route: plan.route,
      router,
      constitution,
      log,
    });
    expect(build.ok).toBe(true);

    const check = await checkPhase({ issue, worktree, specPath, router, constitution, log });
    expect(check.passed).toBe(true);
    expect(check.reworkRounds).toBe(0);

    const ship = await shipPhase({
      issue,
      repo,
      worktree,
      branch,
      octokit: octokit as any,
      watchCI: false,
      log,
    });

    expect(ship).toEqual({ ok: true, prNumber: 101 });
    expect(calls).toContainEqual([
      'pulls.create',
      expect.objectContaining({
        head: branch,
        base: 'main',
        body: expect.stringContaining('Closes #34'),
      }),
    ]);
    expect(calls).toContainEqual([
      'pulls.get',
      expect.objectContaining({ pull_number: 101 }),
    ]);
    expect(calls).toContainEqual([
      'graphql',
      expect.stringContaining('markPullRequestReadyForReview'),
      { id: 'PR_101' },
    ]);
    expect(events.some(([type]) => type === 'ready')).toBe(true);
    await expect(exec(`git -C '${origin}' rev-parse --verify refs/heads/'${branch}'`)).resolves.toBeTruthy();
  });

  it('rework path: failing checker re-invokes worker with failure details, then ships', { timeout: 120_000 }, async () => {
    const title = 'Full pipeline rework path';
    const { repoRoot } = await kit.makeThrowawayRepo();
    const worktree = kit.trackWorktree(repoRoot, issue);
    const branch = branchFor(issue, title);
    const specPath = await kit.makeSpecPath(issue);
    const { octokit, calls } = makeFakeOctokit({ [issue]: title });
    const events: Array<[string, string]> = [];
    const log = (type: string, msg: string) => events.push([type, msg]);
    const stub = new StubModelExecutor({
      scripts: {
        plan: [{ output: specContentFor(issue) }],
        build_claude: [
          {
            output: 'built with failing verify',
            effect: async (ctx) => {
              await writeFile(join(ctx.worktree, 'feature.txt'), 'rework path\n');
              await mkdir(join(ctx.worktree, 'scripts'), { recursive: true });
              await writeFile(join(ctx.worktree, 'scripts', 'verify.sh'), '#!/bin/bash\necho "boom" >&2\nexit 1\n');
              await commitAll(ctx.worktree, 'feat: stub work');
            },
          },
          {
            output: 'fixed',
            effect: async (ctx) => {
              await writeFile(join(ctx.worktree, 'scripts', 'verify.sh'), '#!/bin/bash\nexit 0\n');
              await commitAll(ctx.worktree, 'fix: repair verify script');
            },
          },
        ],
      },
    });
    const router = new ModelRouter(makeStubModelsConfig(), makeStubRoutesConfig(), false, stub);
    const constitution = null;

    const plan = await planPhase({
      issue,
      repo,
      worktree,
      specPath,
      router,
      constitution,
      octokit: octokit as any,
      log,
    });
    expect(plan.ok).toBe(true);
    expect(plan.route).toBe('claude');

    await setupWorktree(repoRoot, branch, worktree);

    const build = await buildPhase({
      issue,
      repo,
      worktree,
      specPath,
      branch,
      route: plan.route,
      router,
      constitution,
      log,
    });
    expect(build.ok).toBe(true);

    const check = await checkPhase({ issue, worktree, specPath, router, constitution, log });
    expect(check.passed).toBe(true);
    expect(check.reworkRounds).toBe(1);

    const buildCalls = stub.calls.filter(call => call.task === 'build_claude');
    expect(buildCalls).toHaveLength(2);
    expect(buildCalls[1].prompt).toContain('Check Failures');
    expect(buildCalls[1].prompt).toContain('### tests');
    expect(buildCalls[1].prompt).toContain('boom');

    const ship = await shipPhase({
      issue,
      repo,
      worktree,
      branch,
      octokit: octokit as any,
      watchCI: false,
      log,
    });

    expect(ship).toEqual({ ok: true, prNumber: 101 });
    expect(events.some(([type]) => type === 'rework')).toBe(true);
    expect(events.some(([type]) => type === 'ready')).toBe(true);
    expect(calls.filter(([name]) => name === 'pulls.create')).toHaveLength(1);
  });
});
