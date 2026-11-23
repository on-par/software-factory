import { join } from 'node:path';

import type { Octokit } from '@octokit/rest';

import type { ReadinessJudgeMode } from '../config/readiness-mode.js';
import { ProviderBreaker } from '../router/breaker.js';
import { ModelRouter } from '../router/index.js';
import { StubModelExecutor } from '../router/stub.js';
import { BUILD_OK, CHECK_OK, request as baseRequest, policy, tmp, WORK } from '../run/ci-rework-test-helpers.js';
import type { RunOutcome } from '../run/outcome.js';
import { runIssue } from '../run/run-issue.js';
import { specContentFor } from './index.js';
import { stubModel, stubModelsConfig } from './phase.js';

const MODELS = stubModelsConfig({ 'stub-model': stubModel() }, { boss: ['stub-model'] });
const ROUTES = {
  version: 1,
  routes: {
    plan: { tier: 'boss', description: 'stub' },
    readiness_judge: { tier: 'boss', description: 'stub' },
  },
};

export const makeJudgedRunDir = (): Promise<string> => tmp.make('run-issue-readiness-');
export const cleanupJudgedRunDirs = (): Promise<void> => tmp.cleanup();

export interface JudgedRunInput {
  worktree: string;
  cacheDir: string;
  octokit: Octokit;
  mode: ReadinessJudgeMode;
  judge: string[];
  title?: string;
  body: string;
}

export async function runIssueWithJudge(input: JudgedRunInput): Promise<{ outcome: RunOutcome; tasks: string[] }> {
  const stub = new StubModelExecutor({
    scripts: {
      readiness_judge: input.judge.map((output) => ({ output })),
      plan: [{ output: specContentFor(1) }],
    },
  });
  const work = { ...WORK, title: input.title ?? WORK.title, brief: input.body };
  const outcome = await runIssue(
    {
      ...baseRequest,
      work,
      specPath: join(input.worktree, 'spec.md'),
      readinessJudge: input.mode,
      readinessCacheDir: input.cacheDir,
    },
    policy,
    {
      router: new ModelRouter(MODELS, ROUTES, false, stub),
      octokit: input.octokit,
      workspace: { path: input.worktree, dispose: async () => {} },
      events: () => () => {},
      breaker: new ProviderBreaker(join(input.worktree, 'breaker.json')),
      resolveConstitution: () => null,
      buildPhase: async () => BUILD_OK,
      checkPhase: async () => CHECK_OK,
      shipPhase: async () => ({ ok: true, prNumber: 42 }),
    },
  );
  return { outcome, tasks: stub.calls.map((c) => c.task) };
}
