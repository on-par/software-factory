import { existsSync } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import type { RoutesConfig } from '../config/index.js';
import { createPhaseTestSetup, fakeOctokit, stubModel, stubModelsConfig } from './phase.js';

describe('fakeOctokit', () => {
  it('returns static responses and handler results per endpoint', async () => {
    const { octokit } = fakeOctokit({
      'issues.get': { data: 1 },
      'pulls.list': (args: unknown) => ({ data: args }),
      'users.getAuthenticated': async () => ({ data: { id: 7 } }),
    });
    expect(await octokit.rest.issues.get({ n: 1 })).toEqual({ data: 1 });
    expect(await octokit.rest.pulls.list({ page: 2 })).toEqual({ data: { page: 2 } });
    expect(await octokit.rest.users.getAuthenticated()).toEqual({ data: { id: 7 } });
  });

  it('records every call with its endpoint and args in order', async () => {
    const { octokit, calls } = fakeOctokit({
      'issues.get': { data: 1 },
      'pulls.list': { data: [] },
      graphql: { ok: true },
    });
    await octokit.rest.issues.get({ a: 1 });
    await octokit.graphql('query Q', { v: 2 });
    await octokit.rest.pulls.list({ b: 3 });
    expect(calls).toEqual([
      ['issues.get', { a: 1 }],
      ['graphql', 'query Q', { v: 2 }],
      ['pulls.list', { b: 3 }],
    ]);
  });

  it('leaves unconfigured endpoints undefined', async () => {
    const { octokit } = fakeOctokit({
      'issues.get': () => {
        throw new Error('boom');
      },
    });
    expect(octokit.rest.pulls).toBeUndefined();
    expect(octokit.graphql).toBeUndefined();
    expect(octokit.rest.issues.list).toBeUndefined();
    await expect(octokit.rest.issues.get()).rejects.toThrow('boom');
  });
});

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
