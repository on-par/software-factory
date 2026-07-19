import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadInjectionFixtures } from '../harness/injection-fixtures.js';
import { ModelRouter } from '../router/index.js';
import { StubModelExecutor } from '../router/stub.js';
import {
  commitAll,
  makeFakeOctokit,
  makeStubModelsConfig,
  makeStubRoutesConfig,
  PipelineTestKit,
  specContentFor,
} from '../test-support/index.js';
import { branchFor, setupWorktree } from '../utils/index.js';
import { buildPhase } from './build.js';
import { checkPhase } from './check.js';
import { planPhase } from './plan.js';
import { shipPhase } from './ship.js';

const repo = 'on-par/software-factory';
const issue = 34;

const kit = new PipelineTestKit();

afterEach(() => kit.cleanup());

describe('pipeline injection integration', () => {
  it.each(loadInjectionFixtures())(
    'does not propagate injected content from fixture $name into pipeline artifacts',
    async (fixture) => {
      const title = 'Pipeline injection adversarial test';
      const { repoRoot } = await kit.makeThrowawayRepo();
      const worktree = kit.trackWorktree(repoRoot, issue);
      const branch = branchFor(issue, title);
      const specPath = await kit.makeSpecPath(issue);
      const { octokit, calls } = makeFakeOctokit({ [issue]: title }, { [issue]: fixture.content });
      const events: Array<[string, string]> = [];
      const log = (type: string, msg: string) => events.push([type, msg]);
      const stub = new StubModelExecutor({
        scripts: {
          plan: [{ output: specContentFor(issue) }],
          build_claude: [
            {
              output: 'built',
              effect: async (ctx) => {
                await writeFile(join(ctx.worktree, 'feature.txt'), 'injection test\n');
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

      const ship = await shipPhase({
        issue,
        repo,
        worktree,
        branch,
        octokit: octokit as any,
        watchCI: false,
        log,
      });
      expect(ship.ok).toBe(true);

      const specContent = await readFile(specPath, 'utf-8');
      const prCreateCall = calls.find(([name]) => name === 'pulls.create');
      expect(prCreateCall).toBeDefined();
      const prArgs = prCreateCall![1] as { title: string; body: string; head: string };

      for (const canary of fixture.canaries) {
        expect(specContent, `spec leaked canary "${canary}"`).not.toContain(canary);
        expect(prArgs.title, `PR title leaked canary "${canary}"`).not.toContain(canary);
        expect(prArgs.body, `PR body leaked canary "${canary}"`).not.toContain(canary);
        expect(branch, `branch name leaked canary "${canary}"`).not.toContain(canary);
      }

      // SHIP opens a PR — it never attempts a merge (the fake Octokit exposes
      // no pulls.merge/merge method; the 'graphql' call name itself doesn't
      // match /merge/i even though its ready-flip mutation body does).
      expect(calls.some(([name]) => /merge/i.test(name))).toBe(false);

      if (fixture.name === 'issue-body-exfil-ssh-key.md') {
        expect(prArgs.body).not.toContain('-----BEGIN OPENSSH PRIVATE KEY-----');
        expect(prArgs.body).not.toContain('CANARY_SSH_EXFIL_7b21');
      }
    },
    120_000,
  );
});
