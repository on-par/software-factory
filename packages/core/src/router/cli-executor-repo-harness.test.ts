import { describe, expect, it } from 'vitest';

import { loadModelsConfig, type RoutesConfig } from '../config/index.js';
import { applyRepoConfig, type RepoFactoryConfig } from '../config/repo.js';
import { CliModelExecutor, ModelRouter } from './index.js';

const routesConfig: RoutesConfig = {
  version: 1,
  routes: { plan: { tier: 'boss', description: 'stub' } },
};
const worktree = '/tmp/factory worktree';
const timeoutSeconds = 7;

describe('CliModelExecutor with repo-declared harnesses', () => {
  it('runs a PLAN-pinned repo model on a harness declared in .factory/config.yaml', async () => {
    const repo: RepoFactoryConfig = {
      version: 2,
      harnesses: {
        'my-agent': {
          command: 'my-agent',
          prompt: 'stdin',
          output: 'stdout',
          agentic: true,
          usage: 'none',
        },
      },
      models: {
        registry: {
          'my-model': {
            provider: 'custom',
            tier: 'worker',
            costPerMtokInput: 0,
            costPerMtokOutput: 0,
            contextWindow: 200000,
            capabilities: ['implementation'],
            envKey: null,
            harness: 'my-agent',
          },
        },
        pins: { plan: 'my-model' },
      },
    };
    const models = applyRepoConfig(loadModelsConfig(), repo);
    const calls: { cmd: string }[] = [];
    const exec = async (cmd: string) => {
      calls.push({ cmd });
      return { stdout: 'OUT', stderr: '' };
    };
    const router = new ModelRouter(models, routesConfig, false, new CliModelExecutor(exec));
    await router.run('plan', 'do it', { worktree, timeoutSeconds, modelOverride: 'my-model' });
    expect(calls[0].cmd).toMatch(/^my-agent /);
    expect(calls[0].cmd).toMatch(/ < '[^']+'/);
    expect(calls[0].cmd).not.toMatch(/< \/dev\/null$/);
  });
});
