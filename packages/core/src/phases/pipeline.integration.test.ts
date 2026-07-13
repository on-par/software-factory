import { exec as execCb } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { ModelRouter } from '../router/index.js';
import { StubModelExecutor } from '../router/stub.js';
import { branchFor, cleanupWorktree, setupWorktree } from '../utils/index.js';
import { buildPhase } from './build.js';
import { checkPhase } from './check.js';
import { planPhase } from './plan.js';
import { shipPhase } from './ship.js';

const exec = promisify(execCb);
const repo = 'on-par/software-factory';
const issue = 34;

const models: ModelsConfig = {
  version: 1,
  models: {
    'stub-model': {
      provider: 'custom',
      tier: 'boss',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
    },
  },
  tiers: { boss: ['stub-model'] },
  failover: {
    triggers: ['rate_limit', 'usage_cap', 'timeout', 'error', 'empty_response'],
    maxRetries: 2,
    cooldownMs: 0,
    escalateAfterTierExhausted: true,
  },
  routingRules: {},
};

const routes: RoutesConfig = {
  version: 1,
  routes: {
    plan: { tier: 'boss', description: 'stub' },
    build_claude: { tier: 'boss', description: 'stub' },
  },
};

const specContent = `---
route: claude
---
# Spec: Pipeline integration test (#34)
## Goal
Exercise the phase pipeline against a throwaway repository.
## Files / approach
Use the scripted stub executor to mutate the worktree.
## Tests
Run the built-in checker sequence.
## Constitution compliance
N/A - no constitution
## Non-goals
No network calls.
`;

const cleanupTargets: Array<{ repoRoot: string; worktree: string }> = [];
const tempDirs = new Set<string>();

afterEach(async () => {
  await Promise.all(cleanupTargets.map(({ repoRoot, worktree }) => cleanupWorktree(repoRoot, worktree)));
  cleanupTargets.length = 0;

  await Promise.all([...tempDirs].map(dir => rm(dir, { recursive: true, force: true })));
  tempDirs.clear();
});

describe('pipeline integration', () => {
  it('green path: PLAN→BUILD→CHECK→SHIP creates a ready PR', { timeout: 120_000 }, async () => {
    const title = 'Full pipeline green path';
    const { origin, repoRoot } = await makeThrowawayRepo();
    const worktree = `${repoRoot}-wt-34`;
    cleanupTargets.push({ repoRoot, worktree });
    const branch = branchFor(issue, title);
    const specPath = await makeSpecPath();
    const { octokit, calls } = makeOctokit(title);
    const events: Array<[string, string]> = [];
    const log = (type: string, msg: string) => events.push([type, msg]);
    const stub = new StubModelExecutor({
      scripts: {
        plan: [{ output: specContent }],
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
    const router = new ModelRouter(models, routes, false, stub);
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
    const { repoRoot } = await makeThrowawayRepo();
    const worktree = `${repoRoot}-wt-34`;
    cleanupTargets.push({ repoRoot, worktree });
    const branch = branchFor(issue, title);
    const specPath = await makeSpecPath();
    const { octokit, calls } = makeOctokit(title);
    const events: Array<[string, string]> = [];
    const log = (type: string, msg: string) => events.push([type, msg]);
    const stub = new StubModelExecutor({
      scripts: {
        plan: [{ output: specContent }],
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
    const router = new ModelRouter(models, routes, false, stub);
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

async function makeThrowawayRepo(): Promise<{ origin: string; repoRoot: string }> {
  const origin = realpathSync(await mkdtemp(join(tmpdir(), 'factory-origin-')));
  const repoRoot = realpathSync(await mkdtemp(join(tmpdir(), 'factory-repo-')));
  tempDirs.add(origin);
  tempDirs.add(repoRoot);

  await exec('git -c init.defaultBranch=main init --bare', { cwd: origin });
  await exec(`git clone '${origin}' '${repoRoot}'`);
  await exec('git config user.name factory-test', { cwd: repoRoot });
  await exec('git config user.email factory@test', { cwd: repoRoot });
  await exec('git checkout -b main', { cwd: repoRoot });
  await writeFile(join(repoRoot, 'README.md'), '# Throwaway\n');
  await commitAll(repoRoot, 'chore: initial commit');
  await exec('git push -u origin main', { cwd: repoRoot });

  return { origin, repoRoot };
}

async function makeSpecPath(): Promise<string> {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'factory-plan-')));
  tempDirs.add(root);
  const plans = join(root, 'plans');
  await mkdir(plans, { recursive: true });
  return join(plans, 'issue-34.md');
}

async function commitAll(cwd: string, message: string): Promise<void> {
  await exec('git add -A', { cwd });
  await exec(`git commit -m '${message}'`, { cwd });
}

function makeOctokit(issueTitle: string) {
  const calls: any[] = [];
  const octokit = {
    graphql: async (query: string, vars: any) => {
      calls.push(['graphql', query, vars]);
      return { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } };
    },
    rest: {
      issues: {
        get: async (args: any) => {
          calls.push(['issues.get', args]);
          return { data: { title: issueTitle, body: 'stub issue body' } };
        },
      },
      pulls: {
        list: async (args: any) => {
          calls.push(['pulls.list', args]);
          return { data: [] };
        },
        create: async (args: any) => {
          calls.push(['pulls.create', args]);
          return { data: { number: 101 } };
        },
        get: async (args: any) => {
          calls.push(['pulls.get', args]);
          return { data: { draft: true, node_id: 'PR_101' } };
        },
      },
      checks: {
        listForRef: async (args: any) => {
          calls.push(['checks.listForRef', args]);
          return { data: { check_runs: [] } };
        },
      },
    },
  };

  return { octokit, calls };
}
