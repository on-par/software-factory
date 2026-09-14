import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { createRunRuntime, type RunRuntime } from './run-runtime.js';
import { createShipExecutor } from './ship-executor.js';
import { writeRegistry } from './registry.js';

const config = {
  version: 2,
  route: 'codex',
  providers: { anthropic: false, openai: true, ollama: false },
  tiers: { boss: ['gpt-5.6-terra-high'], worker: ['gpt-5.6-terra-medium'] },
  models: {
    pins: {
      plan: 'gpt-5.6-terra-high',
      build: 'gpt-5.6-terra-medium',
      checker: 'gpt-5.6-terra-medium',
      triage: 'gpt-5.6-terra-medium',
    },
  },
  policy: { mode: 'pinned' },
  auto_failover: { enabled: false },
};
let runtime: RunRuntime | undefined;
let dir: string;
afterEach(async () => {
  await runtime?.stop();
  vi.unstubAllEnvs();
  if (dir) await rm(dir, { recursive: true, force: true });
});
it('executes an accepted configuration through the real loaders without reading or rewriting the poisoned checkout config', async () => {
  dir = await mkdtemp(join(tmpdir(), 'factory-run-config-'));
  await mkdir(join(dir, '.factory'));
  const localConfig = JSON.stringify({ ...config, tiers: { boss: ['claude-sonnet-5'] } });
  await writeFile(join(dir, '.factory/config.json'), localConfig);
  const registryFile = join(dir, 'registry.json');
  await writeRegistry(registryFile, {
    version: 1,
    repos: { 'test/repo': { path: dir, attachedAt: new Date().toISOString(), state: 'active' } },
  });
  const cliEntrypoint = join(dir, 'probe.mjs');
  const repoModule = new URL('../config/repo.ts', import.meta.url).href;
  const configModule = new URL('../config/index.ts', import.meta.url).href;
  await writeFile(
    cliEntrypoint,
    `
    import { loadRepoConfig, applyRepoConfig } from ${JSON.stringify(repoModule)};
    import { loadModelsConfig, loadFactoryConfigForRepo, resolveAutoFailover } from ${JSON.stringify(configModule)};
    const repo = loadRepoConfig(process.cwd());
    const effective = applyRepoConfig(loadModelsConfig(), repo);
    console.log(JSON.stringify({pins: repo.models.pins, boss: effective.tiers.boss, failover: resolveAutoFailover(loadFactoryConfigForRepo(process.cwd()+'/.factory/config.json')).enabled}));
    console.log('✅ Issue #229 → PR #1 ready for review');
  `,
  );
  vi.stubEnv(
    'NODE_OPTIONS',
    `--import ${new URL('../../../../node_modules/tsx/dist/loader.mjs', import.meta.url).pathname}`,
  );
  vi.stubEnv('FACTORY_AUTO_FAILOVER', '1');
  vi.stubEnv('FACTORY_PLAN_MODEL', 'invalid-local-model');
  vi.stubEnv('FACTORY_LOCAL_ONLY', '1');
  // Use the real executor, process environment and config loaders, with a harmless CLI probe.
  runtime = await createRunRuntime({ registryFile, execute: createShipExecutor({ cliEntrypoint }) });
  const runId = randomUUID();
  await runtime.submit({ runId, repo: 'test/repo', issue: 229, executionConfig: config });
  await expect.poll(() => runtime!.get(runId)?.finishedAt, { timeout: 5000 }).not.toBeNull();
  expect(runtime.logs(runId).text).not.toContain("tier 'boss' has no models left");
  expect(runtime.get(runId)?.status, runtime.logs(runId).text).toBe('succeeded');
  expect(runtime.logs(runId).text).toContain('"boss":["gpt-5.6-terra-high"]');
  expect(runtime.logs(runId).text).toContain('"failover":false');
  expect(await readFile(join(dir, '.factory/config.json'), 'utf8')).toBe(localConfig);
});

it('rejects a changed configuration under the same run identity and retains the accepted snapshot after restart', async () => {
  dir = await mkdtemp(join(tmpdir(), 'factory-run-config-'));
  const registryFile = join(dir, 'registry.json');
  await writeRegistry(registryFile, {
    version: 1,
    repos: { 'test/repo': { path: dir, attachedAt: new Date().toISOString(), state: 'active' } },
  });
  runtime = await createRunRuntime({
    registryFile,
    execute: async () => ({ exitCode: 0, prUrl: 'https://github.com/test/repo/pull/1' }),
  });
  const input = { runId: randomUUID(), repo: 'test/repo', issue: 1, executionConfig: structuredClone(config) };
  const accepted = await runtime.submit(input);
  input.executionConfig.models.pins.plan = 'gpt-5.6-terra-medium';
  await expect(runtime.submit(input)).rejects.toMatchObject({ status: 409 });
  expect(accepted).toMatchObject({ executionConfig: config });
  await expect.poll(() => runtime!.get(input.runId)?.status).toBe('succeeded');
  await runtime.stop();
  runtime = await createRunRuntime({
    registryFile,
    execute: async () => {
      throw new Error('must not launch again');
    },
  });
  expect(runtime.get(input.runId)).toMatchObject({ executionConfig: config, status: 'succeeded' });
});

it('rejects a pin for a disabled provider before executing any work', async () => {
  dir = await mkdtemp(join(tmpdir(), 'factory-run-config-'));
  const registryFile = join(dir, 'registry.json');
  await writeRegistry(registryFile, {
    version: 1,
    repos: { 'test/repo': { path: dir, attachedAt: new Date().toISOString(), state: 'active' } },
  });
  runtime = await createRunRuntime({
    registryFile,
    execute: async () => {
      throw new Error('must not execute');
    },
  });
  await expect(
    runtime.submit({
      runId: randomUUID(),
      repo: 'test/repo',
      issue: 1,
      executionConfig: { ...config, models: { pins: { ...config.models.pins, checker: 'claude-sonnet-5' } } },
    }),
  ).rejects.toMatchObject({ status: 400 });
  expect(runtime.list()).toEqual([]);
});

it('keeps different queued configurations isolated even if callers edit returned snapshots', async () => {
  dir = await mkdtemp(join(tmpdir(), 'factory-run-config-'));
  const registryFile = join(dir, 'registry.json');
  await writeRegistry(registryFile, {
    version: 1,
    repos: { 'test/repo': { path: dir, attachedAt: new Date().toISOString(), state: 'active' } },
  });
  const observed: unknown[] = [];
  let finish!: () => void;
  runtime = await createRunRuntime({
    registryFile,
    execute: async ({ run }) => {
      observed.push(run.executionConfig);
      if (run.issue === 1)
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      return { exitCode: 0, prUrl: 'https://github.com/test/repo/pull/1' };
    },
  });
  const first = await runtime.submit({ runId: randomUUID(), repo: 'test/repo', issue: 1, executionConfig: config });
  await expect.poll(() => observed.length).toBe(1);
  const other = { ...config, models: { pins: { ...config.models.pins, plan: 'gpt-5.6-terra-medium' } } };
  const second = await runtime.submit({ runId: randomUUID(), repo: 'test/repo', issue: 2, executionConfig: other });
  first.executionConfig!.models!.pins!.plan = 'changed-by-caller';
  second.executionConfig!.models!.pins!.plan = 'changed-by-caller';
  finish();
  await expect.poll(() => runtime!.get(second.runId)?.status).toBe('succeeded');
  expect(observed).toEqual([config, other]);
});
