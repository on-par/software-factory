import { workKeyFromIssue } from '../work/work-key.js';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { createTempDirs } from '../harness/temp-dir.js';
import { ModelRouter } from '../router/index.js';
import { StubModelExecutor } from '../router/stub.js';
import { buildPhase } from './build.js';

const base = {
  tier: 'worker',
  costPerMtokInput: 0,
  costPerMtokOutput: 0,
  contextWindow: 1000,
  capabilities: [],
  envKey: null,
};

const models: ModelsConfig = {
  version: 1,
  models: {
    'claude-a': { ...base, provider: 'anthropic', harness: 'claude-cli' },
    'codex-a': { ...base, provider: 'openai', harness: 'codex-cli', codex: true },
  },
  tiers: { worker: ['claude-a', 'codex-a'] },
  failover: { triggers: ['rate_limit', 'unavailable', 'auth'], maxRetries: 0, cooldownMs: 0 },
  routingRules: {},
};

const routes: RoutesConfig = {
  version: 1,
  routes: {
    build_claude: { tier: 'worker', description: 'stub', requires: 'claude' },
    build_codex: { tier: 'worker', description: 'stub', requires: 'codex' },
  },
};

const tempDirs = createTempDirs();
afterEach(() => tempDirs.cleanup());

async function buildOnClaude(crossProviderLadder?: boolean) {
  const worktree = await tempDirs.make('build-provider-order-');
  const stub = new StubModelExecutor({
    scripts: { build_claude: [{ fail: 'usage_cap' }], build_codex: [{ output: 'codex output' }] },
  });
  const run = buildPhase({
    issue: workKeyFromIssue(3338),
    repo: 'on-par/software-factory',
    worktree,
    specPath: join(worktree, 'issue-3338.md'),
    branch: 'factory/3338-x',
    route: 'claude',
    router: new ModelRouter(models, routes, false, stub),
    constitution: null,
    crossProviderLadder,
    log: () => {},
  });
  return { run, stub };
}

describe('buildPhase crossProviderLadder (#3338)', () => {
  it('false: a usage_cap from build_claude rethrows and does not run build_codex', async () => {
    const { run, stub } = await buildOnClaude(false);
    await expect(run).rejects.toMatchObject({ reason: 'usage_cap' });
    expect(stub.calls.some((c) => c.task === 'build_codex')).toBe(false);
  });

  it('unset: the cross-harness ladder continues on codex as before', async () => {
    const { run, stub } = await buildOnClaude();
    const result = await run;
    expect(result.route).toBe('codex');
    expect(stub.calls.some((c) => c.task === 'build_codex')).toBe(true);
  });
});
