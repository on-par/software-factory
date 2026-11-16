import { existsSync } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import type { RoutesConfig } from '../config/index.js';
import { createPhaseTestSetup, stubModel, stubModelsConfig } from './phase.js';

describe('createPhaseTestSetup', () => {
  const setup = createPhaseTestSetup();
  afterEach(() => setup.cleanup());

  it('creates temp worktrees and removes them on cleanup', async () => {
    const worktree = await setup.worktree('phase-harness-');
    expect(worktree).toContain('phase-harness-');
    expect(existsSync(worktree)).toBe(true);
    await setup.cleanup();
    expect(existsSync(worktree)).toBe(false);
  });

  it('builds a stub router whose executor follows the scripts', async () => {
    const models = stubModelsConfig({ 'stub-model': stubModel() }, { boss: ['stub-model'] });
    const routes: RoutesConfig = { version: 1, routes: { plan: { tier: 'boss', description: 'stub' } } };
    const { router, stub } = setup.router(models, routes, { plan: [{ output: 'scripted' }] });
    const result = await router.run('plan', 'do it', { worktree: await setup.worktree() });
    expect(result.output).toBe('scripted');
    expect(stub.calls.map((call) => call.task)).toEqual(['plan']);
  });

  it('builds a zero-cost stub models config', () => {
    expect(stubModel()).toEqual({
      provider: 'custom',
      tier: 'boss',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
    });
    expect(stubModel({ provider: 'openai', codex: true }).provider).toBe('openai');
    const config = stubModelsConfig({ a: stubModel() }, { boss: ['a'] });
    expect(config.failover).toEqual({ triggers: ['rate_limit', 'unavailable', 'auth'], maxRetries: 2, cooldownMs: 0 });
    expect(config.tiers).toEqual({ boss: ['a'] });
  });
});
