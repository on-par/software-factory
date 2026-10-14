import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { ModelRouter } from '../router/index.js';
import { StubModelExecutor } from '../router/stub.js';
import { checkPhase } from './check.js';
import { runnableBuildRoutes } from './plan-routes.js';

const failover: ModelsConfig['failover'] = {
  triggers: ['rate_limit', 'usage_cap', 'timeout', 'error', 'empty_response'],
  maxRetries: 2,
  cooldownMs: 0,
  escalateAfterTierExhausted: true,
};

const commandModels: ModelsConfig = {
  version: 1,
  models: {
    'my-model': {
      provider: 'custom',
      tier: 'worker',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
      harness: 'my-agent',
    },
  },
  tiers: { worker: ['my-model'] },
  failover,
  routingRules: {},
  harnesses: {
    'my-agent': { command: 'my-agent {model}', prompt: 'stdin', output: 'stdout', agentic: true, usage: 'none' },
  },
};

const commandRoutes: RoutesConfig = {
  version: 1,
  routes: {
    build_claude: { tier: 'worker', description: 'stub', requires: 'claude' },
    build_codex: { tier: 'worker', description: 'stub', requires: 'codex' },
    build_command: { tier: 'worker', description: 'stub', requires: 'command' },
  },
};

const codexModels: ModelsConfig = {
  version: 1,
  models: {
    'codex-worker': {
      provider: 'openai',
      tier: 'boss',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: ['codex'],
      envKey: null,
      codex: true,
    },
    'claude-worker': {
      provider: 'anthropic',
      tier: 'boss',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: ['claude'],
      envKey: null,
    },
  },
  tiers: { boss: ['codex-worker', 'claude-worker'] },
  failover,
  routingRules: {},
};

const codexRoutes: RoutesConfig = {
  version: 1,
  routes: {
    build_codex: { tier: 'boss', description: 'codex', requires: 'codex' },
    build_claude: { tier: 'boss', description: 'claude', requires: 'claude' },
  },
};

const tempDirs = new Set<string>();

afterEach(async () => {
  await Promise.all([...tempDirs].map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.clear();
});

async function makeFailingWorktree(): Promise<{ worktree: string; specPath: string }> {
  const worktree = await mkdtemp(join(tmpdir(), 'check-command-rework-'));
  tempDirs.add(worktree);
  await writeFile(join(worktree, 'package.json'), JSON.stringify({ scripts: { test: 'exit 1' } }));
  const specPath = join(worktree, 'issue-2873.md');
  await writeFile(specPath, '# Spec: failing checks\n');
  return { worktree, specPath };
}

describe('checkPhase auto rework on the command route (#2873)', () => {
  it(
    'keeps rework on the command route with the pinned declared-harness model (#2873)',
    { timeout: 120_000 },
    async () => {
      const { worktree, specPath } = await makeFailingWorktree();
      const stub = new StubModelExecutor({ scripts: { build_command: [{ output: 'rework complete' }] } });
      const router = new ModelRouter(commandModels, commandRoutes, false, stub);
      const runSpy = vi.spyOn(router, 'run');
      const logs: Array<[string, string]> = [];

      await checkPhase({
        issue: 2873,
        worktree,
        specPath,
        router,
        constitution: null,
        log: (type, msg) => logs.push([type, msg]),
        maxReworkRounds: 1,
        reworkRoute: 'command',
        reworkModel: 'my-model',
      });

      expect(runSpy.mock.calls[0][0]).toBe('build_command');
      expect(runSpy.mock.calls[0][2]?.modelOverride).toBe('my-model');
      expect(stub.calls[0]).toMatchObject({ task: 'build_command', model: 'my-model' });
      expect(logs.some(([, msg]) => msg.includes('rework route command has no runnable model'))).toBe(false);
    },
  );

  it('reroutes an unrunnable command rework route and logs why (#2873)', { timeout: 120_000 }, async () => {
    const { worktree, specPath } = await makeFailingWorktree();
    const stub = new StubModelExecutor({
      scripts: { build_codex: [{ output: 'rework complete' }], build_claude: [{ output: 'rework complete' }] },
    });
    const router = new ModelRouter(codexModels, codexRoutes, false, stub);
    const runSpy = vi.spyOn(router, 'run');
    const logs: Array<[string, string]> = [];

    await checkPhase({
      issue: 2873,
      worktree,
      specPath,
      router,
      constitution: null,
      log: (type, msg) => logs.push([type, msg]),
      maxReworkRounds: 1,
      reworkRoute: 'command',
    });

    const override = logs.find(([type]) => type === 'model-override');
    expect(override?.[1]).toContain('rework route command has no runnable model on this machine, rerouting to');
    expect(stub.calls[0].task).toBe(`build_${runnableBuildRoutes(router)[0]}`);
    expect(runSpy.mock.calls[0][2]?.modelOverride).toBeUndefined();
  });
});
