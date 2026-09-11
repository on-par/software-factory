import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { loadModelsConfig, loadRoutesConfig } from '../config/index.js';
import { applyRepoConfig, loadRepoConfig, resolveEffectiveModelPins } from '../config/repo.js';
import { ModelRegistry } from '../models/index.js';
import { CliModelExecutor } from '../router/index.js';

it.each(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const)(
  'runs pinned Astra at %s effort independently per task',
  async (effort) => {
    const root = await mkdtemp(join(tmpdir(), 'factory-effort-'));
    try {
      await mkdir(join(root, '.factory'));
      await writeFile(
        join(root, '.factory/config.json'),
        JSON.stringify({
          version: 2,
          models: {
            pins: { plan: 'gpt-6-astra' },
            efforts: { 'gpt-6-astra': { plan: effort, build_codex: 'low' } },
          },
        }),
      );
      const repo = loadRepoConfig(root);
      const registry = new ModelRegistry(applyRepoConfig(loadModelsConfig(), repo));
      const model = resolveEffectiveModelPins(registry, repo, {}).plan!;
      const commands: string[] = [];
      const executor = new CliModelExecutor(async (cmd) => {
        commands.push(cmd);
        await writeFile(cmd.match(/-o '([^']+)'/)![1], 'done');
        return { stdout: '', stderr: 'model: gpt-6-astra' };
      });
      for (const task of ['plan', 'build_codex']) {
        expect(
          await executor.runModel(model, 'test', {
            task,
            registry,
            routesConfig: loadRoutesConfig(),
            worktree: root,
            timeoutSeconds: 5,
          }),
        ).toBe('done');
      }
      expect(commands[0]).toContain('-m gpt-6-astra');
      expect(commands[0]).toContain(`model_reasoning_effort=${effort}`);
      expect(commands[1]).toContain('model_reasoning_effort=low');
      expect(commands[0]).toContain(`model_reasoning_effort=medium -c 'model_reasoning_effort=${effort}'`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.each([
  ['claude-opus-5', 'high', "--effort 'high'"],
  ['opencode-deepseek-v4-flash-free', 'low', "--variant 'low'"],
] as const)('passes model and effort to %s without losing the lane environment', async (model, effort, flag) => {
  const registry = new ModelRegistry(
    applyRepoConfig(loadModelsConfig(), {
      version: 2,
      models: { efforts: { [model]: effort } },
    }),
  );
  let command = '';
  const executor = new CliModelExecutor(async (cmd, options) => {
    command = cmd;
    expect(options?.env).toMatchObject({ PORT: '3456' });
    if (model === 'claude-opus-5') expect(options?.env).toMatchObject({ CLAUDE_CODE_EFFORT_LEVEL: 'high' });
    return { stdout: 'done', stderr: '' };
  });
  expect(
    await executor.runModel(model, 'test', {
      task: 'plan',
      registry,
      routesConfig: loadRoutesConfig(),
      worktree: '/tmp',
      timeoutSeconds: 5,
      env: { PORT: '3456', CLAUDE_CODE_EFFORT_LEVEL: 'low' },
    }),
  ).toBe('done');
  expect(command).toContain(flag);
  expect(command).toContain('--model');
});

it.each(['qwen3.5:9b', 'codex-ollama-qwen3.5:9b'])('passes thinking to the HTTP request for %s', async (model) => {
  const registry = new ModelRegistry(
    applyRepoConfig(loadModelsConfig(), {
      version: 2,
      models: { efforts: { [model]: false } },
    }),
  );
  let body: unknown;
  const executor = new CliModelExecutor(undefined, async (_url, init) => {
    body = JSON.parse(init!.body!);
    return { ok: false, status: 400, statusText: 'test stop', text: async () => 'test stop', json: async () => ({}) };
  });
  await expect(
    executor.runModel(model, 'test', {
      task: 'plan',
      registry,
      routesConfig: loadRoutesConfig(),
      worktree: '/tmp',
      timeoutSeconds: 5,
    }),
  ).rejects.toThrow('test stop');
  expect(body).toMatchObject({ model: 'qwen3.5:9b', think: false });
});

it.each([
  ['missing-model', 'high'],
  ['claude-opus-5', 'ultra'],
  ['gpt-6-astra', false],
  ['qwen3.5:9b', 'xhigh'],
  ['gpt-6-astra', 'high; touch /tmp/injected'],
  ['gpt-6-astra', { plan: 'not-an-effort' }],
])('rejects invalid effort configuration for %s before executing anything', (model, effort) => {
  expect(() => new ModelRegistry({ ...loadModelsConfig(), efforts: { [model]: effort } } as never)).toThrow();
});

it('retains defaults for omitted tasks and other models', () => {
  const registry = new ModelRegistry(
    applyRepoConfig(loadModelsConfig(), {
      version: 2,
      models: { efforts: { 'gpt-6-astra': { plan: 'ultra' } } },
    }),
  );
  expect(registry.getEffort('gpt-6-astra', 'plan')).toBe('ultra');
  expect(registry.getEffort('gpt-6-astra', 'build_codex')).toBeUndefined();
  expect(registry.getEffort('gpt-5.6-sol', 'plan')).toBeUndefined();
  expect(registry.getEffort('gpt-6-astra', 'toString')).toBeUndefined();
  expect(registry.getEffort('constructor', 'plan')).toBeUndefined();
});

it('preserves task effort through the legacy Ollama command agent and its repair call', async () => {
  const root = await mkdtemp(join(tmpdir(), 'factory-effort-'));
  try {
    const config = loadModelsConfig();
    const model = 'qwen3.5:9b';
    config.models[model] = { ...config.models[model], harness: 'ollama-command-agent' };
    config.efforts = { [model]: { plan: 'high', build_codex: 'low' } };
    const bodies: { think: string }[] = [];
    const executor = new CliModelExecutor(
      async () => ({ stdout: '', stderr: '' }),
      async (_url, init) => {
        bodies.push(JSON.parse(init!.body!));
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          text: async () => '',
          json: async () => ({
            message: { content: bodies.length === 1 ? 'malformed' : '{"commands":[],"done":true,"final":"done"}' },
          }),
        };
      },
    );
    await executor.runModel(model, 'test', {
      task: 'plan',
      registry: new ModelRegistry(config),
      routesConfig: loadRoutesConfig(),
      worktree: root,
      timeoutSeconds: 5,
    });
    expect(bodies.map((body) => body.think)).toEqual(['high', 'high']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('preserves arbitrary Codex profile flags and appends effort with final precedence', async () => {
  const config = loadModelsConfig();
  const flags = `-m gpt-6-astra -c 'developer_instructions="keep -c model_reasoning_effort=high literal"'`;
  config.models['gpt-6-astra'].codexFlag = flags;
  config.efforts = { 'gpt-6-astra': 'low' };
  let command = '';
  const executor = new CliModelExecutor(async (cmd) => {
    command = cmd;
    await writeFile(cmd.match(/-o '([^']+)'/)![1], 'done');
    return { stdout: '', stderr: '' };
  });
  await executor.runModel('gpt-6-astra', 'test', {
    task: 'plan',
    registry: new ModelRegistry(config),
    routesConfig: loadRoutesConfig(),
    worktree: '/tmp',
    timeoutSeconds: 5,
  });
  expect(command).toContain(`${flags} -c 'model_reasoning_effort=low'`);
});
