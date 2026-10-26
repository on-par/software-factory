import { workKeyFromIssue } from '../work/work-key.js';
import { join } from 'node:path';

import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, expect, it, vi } from 'vitest';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { ModelRouter } from '../router/index.js';
import { planPhase } from './plan.js';
import { StubModelExecutor } from './plan-test-helpers.js';

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
  failover: { triggers: [], maxRetries: 0, cooldownMs: 0 },
  routingRules: {},
};
const routes: RoutesConfig = { version: 1, routes: { plan: { tier: 'boss', description: 'stub' } } };

const tempDirs = createTempDirs();
afterEach(async () => {
  await tempDirs.cleanup();
});

it('forwards skipProviders to the plan router call (#3226)', async () => {
  const worktree = await tempDirs.make('plan-skip-providers-');
  const stub = new StubModelExecutor({ scripts: { plan: [{ output: '---\nroute: claude\n---\n# Spec\n' }] } });
  const router = new ModelRouter(models, routes, false, stub);
  const octokit: any = { rest: { issues: { get: async () => ({ data: { title: 'Skip', body: 'Do it.' } }) } } };
  const skipProviders = new Set(['anthropic']);
  const seen: unknown[] = [];
  const run = router.run.bind(router);
  vi.spyOn(router, 'run').mockImplementation(async (task, prompt, o) => {
    seen.push(task === 'plan' ? o?.skipProviders : undefined);
    return run(task, prompt, o);
  });

  await planPhase({
    issue: workKeyFromIssue(81),
    repo: 'on-par/software-factory',
    worktree,
    specPath: join(worktree, 'issue-81.md'),
    router,
    constitution: null,
    octokit,
    log: () => {},
    skipProviders,
  });

  expect(seen[0]).toBe(skipProviders);
});
