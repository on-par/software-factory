// Real-CLI full loop (#2649): PLAN, BUILD, CHECK and SHIP through the real Codex or OpenCode CLI in a throwaway repo,
// with only GitHub faked. Runs nightly via scripts/real-cli-smoke.sh when FACTORY_REAL_CLI=<codex|opencode>;
// vitest.config.ts keeps it out of every other run.
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadModelsConfig, loadRoutesConfig, type ModelsConfig } from '../config/index.js';
import { ModelRouter } from '../router/index.js';
import { makeFakeOctokit, PipelineTestKit } from '../test-support/index.js';
import { branchFor, setupWorktree } from '../utils/index.js';
import { buildPhase } from './build.js';
import { checkPhase } from './check.js';
import { planPhase } from './plan.js';
import { shipPhase } from './ship.js';
import { reworkRouteFor } from '../run/outcome.js';

const AGENTS: Record<string, { model: string; cmd: string }> = {
  codex: { model: 'gpt-5.6-terra-medium', cmd: 'codex' },
  opencode: { model: 'opencode-deepseek-v4-flash', cmd: 'opencode' },
};

const agent = process.env.FACTORY_REAL_CLI;
const selected = agent ? AGENTS[agent] : undefined;
const repo = 'on-par/software-factory';
const issue = 42;

function singleModelConfig(model: string): ModelsConfig {
  const base = loadModelsConfig();
  const def = base.models[model];
  if (!def) throw new Error(`default model ${model} not found`);
  const list = [model];
  return {
    ...base,
    models: { [model]: { ...def, tier: ['boss', 'worker', 'checker'] } },
    tiers: { boss: list, worker: list, checker: list, triage: list },
    failover: { ...base.failover, maxRetries: 0 },
  };
}

const kit = new PipelineTestKit();

afterEach(async () => {
  await kit.cleanup();
});

describe.skipIf(!selected)(`real ${agent} CLI full loop (#2649)`, () => {
  it('runs PLAN, BUILD, CHECK and SHIP on the real CLI', { timeout: 20 * 60_000 }, async () => {
    const { model, cmd } = selected!;
    const title = 'Add hello.txt';
    const body = 'Add a file `hello.txt` at the repository root containing exactly `hello`.';
    const { repoRoot } = await kit.makeThrowawayRepo();
    const worktree = kit.trackWorktree(repoRoot, issue);
    const branch = branchFor(issue, title);
    const specPath = await kit.makeSpecPath(issue);
    const { octokit } = makeFakeOctokit({ [issue]: title }, { [issue]: body });
    const events: Array<[string, string]> = [];
    const log = (type: string, msg: string) => events.push([type, msg]);

    const router = new ModelRouter(singleModelConfig(model), loadRoutesConfig());
    router.skipMissingHarnessClis((c) => c === cmd);
    const costs: string[] = [];
    router.setCostSink((e) => costs.push(e.model));

    try {
      await setupWorktree(repoRoot, branch, worktree);
      const plan = await planPhase({
        issue,
        repo,
        worktree,
        specPath,
        router,
        constitution: null,
        octokit: octokit as any,
        log,
      });
      expect(plan.ok).toBe(true);

      const build = await buildPhase({
        issue,
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

      const check = await checkPhase({
        issue,
        worktree,
        specPath,
        router,
        constitution: null,
        log,
        ...reworkRouteFor(build.route, undefined),
      });
      expect(check.passed).toBe(true);

      const ship = await shipPhase({ issue, repo, worktree, branch, octokit: octokit as any, watchCI: false, log });
      expect(ship.ok).toBe(true);

      expect(existsSync(join(worktree, 'hello.txt'))).toBe(true);
      expect(costs.length).toBeGreaterThan(0);
      expect(costs.every((m) => m === model)).toBe(true);
    } catch (err) {
      console.error(events.map(([t, m]) => `[${t}] ${m}`).join('\n'));
      throw err;
    }
  });
});
