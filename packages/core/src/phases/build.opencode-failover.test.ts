import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { ModelRouter } from '../router/index.js';
import { StubModelExecutor } from '../router/stub.js';
import { buildPhase } from './build.js';

const tempDirs = new Set<string>();

afterEach(async () => {
  await Promise.all([...tempDirs].map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.clear();
});

describe('buildPhase opencode failover (#2885)', () => {
  const model = (extra: Partial<ModelsConfig['models'][string]>): ModelsConfig['models'][string] => ({
    provider: 'custom',
    tier: 'worker',
    costPerMtokInput: 0,
    costPerMtokOutput: 0,
    contextWindow: 1000,
    capabilities: [],
    envKey: null,
    ...extra,
  });
  const ocModels = (tier: string[]): ModelsConfig =>
    ({
      version: 1,
      models: {
        'oc-a': model({ provider: 'deepseek', harness: 'opencode' }),
        'claude-sonnet-5': model({ provider: 'anthropic', harness: 'claude-cli' }),
        'codex-a': model({ provider: 'openai', capabilities: ['codex'], codex: true, harness: 'codex-cli' }),
      },
      tiers: { worker: tier },
      failover: {
        triggers: ['rate_limit', 'usage_cap', 'timeout', 'error', 'empty_response'],
        maxRetries: 1,
        cooldownMs: 0,
        escalateAfterTierExhausted: true,
      },
      routingRules: {},
    }) as ModelsConfig;
  const ocRoutes: RoutesConfig = {
    version: 1,
    routes: {
      build_opencode: { tier: 'worker', description: 'stub', requires: 'opencode' },
      build_claude: { tier: 'worker', description: 'stub', requires: 'claude' },
      build_codex: { tier: 'worker', description: 'stub', requires: 'codex' },
    },
  };

  async function setup(
    fail: 'usage_cap' | 'rate_limit' | 'error',
    tier: string[],
    extra: { routePinned?: boolean; autoFailover?: { enabled: boolean } } = {},
  ) {
    const worktree = await mkdtemp(join(tmpdir(), 'build-phase-test-'));
    tempDirs.add(worktree);
    const stub = new StubModelExecutor({
      scripts: {
        build_opencode: [{ fail }, { fail }],
        build_claude: [{ output: 'claude output' }],
        build_codex: [{ output: 'codex output' }],
      },
    });
    const router = new ModelRouter(ocModels(tier), ocRoutes, false, stub);
    const runSpy = vi.spyOn(router, 'run');
    const logCalls: Array<[string, string, ({ failoverReason?: string } | undefined)?]> = [];
    const run = buildPhase({
      issue: 2885,
      repo: 'on-par/software-factory',
      worktree,
      specPath: join(worktree, 'issue-2885.md'),
      branch: 'factory/2885-opencode-failover',
      route: 'opencode',
      router,
      constitution: null,
      ...extra,
      log: (type, msg, x) => {
        logCalls.push([type, msg, x]);
      },
    });
    return { run, stub, runSpy, logCalls };
  }

  it('continues an opencode build on claude when every opencode worker is capped', async () => {
    const { run, stub, runSpy, logCalls } = await setup('usage_cap', ['oc-a', 'claude-sonnet-5', 'codex-a']);
    const result = await run;
    expect(result.ok).toBe(true);
    expect(result.route).toBe('claude');
    expect(result.failoverReason).toBe('usage_cap');
    expect(runSpy).toHaveBeenNthCalledWith(
      2,
      'build_claude',
      expect.any(String),
      expect.objectContaining({ retryCause: 'failover', modelOverride: 'claude-sonnet-5' }),
    );
    expect(stub.calls.at(-1)).toMatchObject({ task: 'build_claude', model: 'claude-sonnet-5' });
    expect(logCalls).toContainEqual([
      'worker_failover',
      expect.stringMatching(/from_route=build_opencode to_route=build_claude/),
      { failoverReason: 'usage_cap' },
    ]);
  });

  it('continues on codex when no claude build worker resolves', async () => {
    const { run, runSpy } = await setup('rate_limit', ['oc-a', 'codex-a']);
    const result = await run;
    expect(result.route).toBe('codex');
    expect(runSpy).toHaveBeenNthCalledWith(
      2,
      'build_codex',
      expect.any(String),
      expect.objectContaining({ retryCause: 'failover', modelOverride: 'codex-a' }),
    );
  });

  it('does not fail over a repo-pinned opencode route', async () => {
    const { run, runSpy, logCalls } = await setup('usage_cap', ['oc-a', 'claude-sonnet-5'], { routePinned: true });
    await expect(run).rejects.toMatchObject({ reason: 'usage_cap' });
    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(logCalls.some(([t]) => t === 'worker_failover')).toBe(false);
  });

  it('does not fail over when autoFailover is disabled', async () => {
    const { run, logCalls } = await setup('rate_limit', ['oc-a', 'claude-sonnet-5'], {
      autoFailover: { enabled: false },
    });
    await expect(run).rejects.toMatchObject({ reason: 'rate_limit' });
    expect(logCalls.some(([t]) => t === 'worker_failover')).toBe(false);
  });

  it('does not fail over on a non-provider failure', async () => {
    const { run, stub } = await setup('error', ['oc-a', 'claude-sonnet-5']);
    await expect(run).rejects.toMatchObject({ reason: 'error' });
    expect(stub.calls.some((c) => c.task === 'build_claude' || c.task === 'build_codex')).toBe(false);
  });
});
