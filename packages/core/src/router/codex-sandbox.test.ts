// packages/core/src/router/codex-sandbox.test.ts — ModelRouter carries sandbox.codexSandbox onto Codex requests (#3830)
import { describe, expect, it, vi } from 'vitest';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import type { CodingHarness, HarnessRequest } from '../harness/index.js';
import type { ExecFn } from '../utils/exec.js';
import { CliModelExecutor, type ModelExecutorContext, ModelRouter } from './index.js';

const fakeGitExec: ExecFn = async () => ({ stdout: '', stderr: '' });

const stubModel: ModelsConfig['models'][string] = {
  provider: 'custom',
  tier: 'boss',
  costPerMtokInput: 0,
  costPerMtokOutput: 0,
  contextWindow: 1000,
  capabilities: [],
  envKey: null,
};

const models: ModelsConfig = {
  version: 1,
  models: { 'stub-model': stubModel },
  tiers: { boss: ['stub-model'] },
  failover: { triggers: ['rate_limit', 'unavailable', 'auth'], maxRetries: 2, cooldownMs: 0 },
  routingRules: {},
};

const routes: RoutesConfig = {
  version: 1,
  routes: {
    plan: { tier: 'boss', description: 'stub' },
    build_claude: { tier: 'boss', description: 'stub' },
  },
};

function recordingExecutor(seenCtx: ModelExecutorContext[]) {
  return {
    async runModel(_model: string, _prompt: string, ctx: ModelExecutorContext) {
      seenCtx.push(ctx);
      return 'ok';
    },
  };
}

describe('ModelRouter codex sandbox threading (#3830)', () => {
  it('carries codexSandbox alongside codexFullAccessTasks on every executor context', async () => {
    const seenCtx: ModelExecutorContext[] = [];
    const router = new ModelRouter(models, routes, false, recordingExecutor(seenCtx));
    router.setCodexFullAccessTasks(['build_codex']);
    router.setCodexSandbox('danger-full-access');
    await router.run('plan', 'do it');
    await router.run('build_claude', 'build it');
    expect(seenCtx).toHaveLength(2);
    for (const ctx of seenCtx) {
      expect(ctx.codexSandbox).toBe('danger-full-access');
      expect(ctx.codexFullAccessTasks).toEqual(['build_codex']);
    }
  });

  it('forwards codexSandbox onto the Codex HarnessRequest', async () => {
    const codexModels: ModelsConfig = {
      ...models,
      models: { 'codex-model': { ...stubModel, provider: 'openai', harness: 'codex-cli' } },
      tiers: { boss: ['codex-model'] },
    };
    const run = vi.fn(async (_req: HarnessRequest) => ({ output: 'ok' }));
    const codex: CodingHarness = { id: 'codex-cli', agentic: true, run };
    const router = new ModelRouter(
      codexModels,
      routes,
      false,
      new CliModelExecutor(undefined, undefined, { 'codex-cli': codex }),
      false,
      false,
      fakeGitExec,
    );
    router.setCodexFullAccessTasks(['build_codex']);
    router.setCodexSandbox('danger-full-access');
    await router.run('plan', 'do it');
    expect(run).toHaveBeenCalledTimes(1);
    const req = run.mock.calls[0]![0];
    expect(req.codexSandbox).toBe('danger-full-access');
    expect(req.codexFullAccessTasks).toEqual(['build_codex']);
  });

  it('leaves codexSandbox undefined when the setter is never called or is reset', async () => {
    const seenCtx: ModelExecutorContext[] = [];
    const router = new ModelRouter(models, routes, false, recordingExecutor(seenCtx));
    await router.run('plan', 'do it');
    expect(seenCtx[0].codexSandbox).toBeUndefined();
    router.setCodexSandbox('workspace-write');
    router.setCodexSandbox(undefined);
    await router.run('plan', 'again');
    expect(seenCtx[1].codexSandbox).toBeUndefined();
  });
});
