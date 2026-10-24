import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { createTempDirs } from '../harness/temp-dir.js';
import { ModelRouter } from '../router/index.js';
import { StubModelExecutor } from '../router/stub.js';
import { buildPhase } from './build.js';

const models: ModelsConfig = {
  version: 1,
  models: {
    'stub-worker': {
      provider: 'custom',
      tier: 'worker',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
    },
  },
  tiers: { worker: ['stub-worker'] },
  failover: { triggers: ['rate_limit', 'unavailable', 'auth'], maxRetries: 2, cooldownMs: 0 },
  routingRules: {},
};
const routes: RoutesConfig = { version: 1, routes: { build_claude: { tier: 'worker', description: 'stub' } } };

const tempDirs = createTempDirs();
afterEach(() => tempDirs.cleanup());

const ENV_LINE = 'ENV-ERROR: verify: ENVIRONMENT ERROR: loopback bind denied (EPERM)';

describe('buildPhase sandbox environment error (#3332)', () => {
  it.each([
    ['ENV-ERROR only', ENV_LINE],
    ['ENV-ERROR and ESCALATE', `ESCALATE: what now?\n${ENV_LINE}`],
  ])('returns sandbox_env without diffing when the worker prints an ENV-ERROR line (%s)', async (_name, output) => {
    const worktree = await tempDirs.make('build-phase-test-');
    const stub = new StubModelExecutor({ scripts: { build_claude: [{ output }] } });
    const router = new ModelRouter(models, routes, false, stub);
    const collectDiff = vi.fn();

    const result = await buildPhase({
      issue: 86,
      repo: 'on-par/software-factory',
      worktree,
      specPath: join(worktree, 'issue-86.md'),
      branch: 'ship-it/86-env',
      route: 'claude',
      router,
      constitution: null,
      collectDiff,
      log: () => {},
    });

    expect(result).toMatchObject({ ok: false, reason: 'sandbox_env' });
    expect(result.sandboxEnv).toContain(ENV_LINE);
    expect(result.escalate).toBeUndefined();
    expect(collectDiff).not.toHaveBeenCalled();
  });
});
