import { workKeyFromIssue } from '../work/work-key.js';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { createTempDirs } from '../harness/temp-dir.js';
import { ModelRouter } from '../router/index.js';
import { StubModelExecutor } from '../router/stub.js';
import { checkPhase } from './check.js';

const models: ModelsConfig = {
  version: 1,
  models: {
    'stub-model': {
      provider: 'openai',
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
    triggers: ['rate_limit', 'unavailable', 'auth'],
    maxRetries: 2,
    cooldownMs: 0,
  },
  routingRules: {},
};

const routes: RoutesConfig = { version: 1, routes: { build_claude: { tier: 'boss', description: 'stub' } } };

const tmp = createTempDirs();

afterEach(async () => {
  await tmp.cleanup();
});

describe('checkPhase compile timeout (#3185)', () => {
  it('threads compileTimeoutSeconds into the checker context', async () => {
    const worktree = await tmp.make('check-phase-compile-');
    await writeFile(join(worktree, 'issue-3185.md'), '# Spec\n');
    const router = new ModelRouter(models, routes, false, new StubModelExecutor({ defaultOutput: 'ok' }));
    let seen: number | undefined;
    await checkPhase({
      issue: workKeyFromIssue(3185),
      worktree,
      specPath: join(worktree, 'issue-3185.md'),
      router,
      constitution: null,
      log: () => {},
      compileTimeoutSeconds: 900,
      runCheckers: async (ctx) => {
        seen = ctx.compileTimeoutSeconds;
        return {
          failures: 0,
          passes: 1,
          skips: 0,
          total: 1,
          results: [{ checker: 'compile', result: 'PASS', details: 'ok' }],
        };
      },
    });
    expect(seen).toBe(900);
  });
});
