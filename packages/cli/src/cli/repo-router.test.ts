import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getFactoryPaths,
  loadFactoryConfig,
  loadFactoryConfigForRepo,
  loadModelsConfig,
  loadRoutesConfig,
  ModelRouter,
} from '@on-par/factory-core';
import { recordLocalAuthFailure } from '@on-par/factory-core/internal';
import { createTempDirs } from '@on-par/factory-core/testing';

import { newRepoRouter, type RepoRouterLoaders } from './repo-router.js';

const dirs = createTempDirs();

afterEach(async () => {
  vi.restoreAllMocks();
  await dirs.cleanup();
});

describe('newRepoRouter', () => {
  it('builds the router from the given loaders, applying the repo sandbox and local-auth sink', () => {
    const models = loadModelsConfig();
    const routes = loadRoutesConfig();
    const factory = loadFactoryConfig();
    const loaders: RepoRouterLoaders = {
      loadRepoConfig: vi.fn(() => null),
      loadModelsConfig: vi.fn(() => models),
      loadRoutesConfig: vi.fn(() => routes),
      loadFactoryConfigForRepo: vi.fn(() => ({
        ...factory,
        sandbox: { ...factory.sandbox, codexFullAccessTasks: ['build_codex'] },
      })),
    };
    const constructed: ConstructorParameters<typeof ModelRouter>[] = [];
    class SpyRouter extends ModelRouter {
      constructor(...args: ConstructorParameters<typeof ModelRouter>) {
        super(...args);
        constructed.push(args);
      }
    }
    const setCodexFullAccessTasks = vi.spyOn(SpyRouter.prototype, 'setCodexFullAccessTasks');
    const setLocalAuthSink = vi.spyOn(SpyRouter.prototype, 'setLocalAuthSink');

    const router = newRepoRouter('/repo', loaders, SpyRouter);

    expect(router).toBeInstanceOf(SpyRouter);
    expect(loaders.loadRepoConfig).toHaveBeenCalledWith('/repo');
    expect(loaders.loadFactoryConfigForRepo).toHaveBeenCalledWith(getFactoryPaths('/repo').config);
    expect(constructed).toHaveLength(1);
    const [modelsArg, routesArg, verbose, executor, allowExperimental, localOnly] = constructed[0]!;
    expect(modelsArg).toBe(models);
    expect(routesArg).toBe(routes);
    expect(verbose).toBe(false);
    expect(executor).toBeUndefined();
    expect(typeof allowExperimental).toBe('boolean');
    expect(typeof localOnly).toBe('boolean');
    expect(setCodexFullAccessTasks).toHaveBeenCalledWith(['build_codex']);
    expect(setLocalAuthSink).toHaveBeenCalledWith(recordLocalAuthFailure);
  });

  it('passes sandbox.codexSandbox to setCodexSandbox (#3830)', () => {
    const factory = loadFactoryConfig();
    const loaders: RepoRouterLoaders = {
      loadRepoConfig: vi.fn(() => null),
      loadModelsConfig: vi.fn(() => loadModelsConfig()),
      loadRoutesConfig: vi.fn(() => loadRoutesConfig()),
      loadFactoryConfigForRepo: vi.fn(() => ({
        ...factory,
        sandbox: { ...factory.sandbox, codexSandbox: 'workspace-write' as const },
      })),
    };
    const setCodexSandbox = vi.spyOn(ModelRouter.prototype, 'setCodexSandbox');
    newRepoRouter('/repo', loaders, ModelRouter);
    expect(setCodexSandbox).toHaveBeenCalledWith('workspace-write');
  });

  it('an unknown sandbox.codexSandbox in config reaches setCodexSandbox as undefined (#3830)', () => {
    const root = dirs.makeSync('repo-router-');
    const configPath = getFactoryPaths(root).config;
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, 'sandbox:\n  codexSandbox: read-only\n');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const loaders: RepoRouterLoaders = {
      loadRepoConfig: vi.fn(() => null),
      loadModelsConfig: vi.fn(() => loadModelsConfig()),
      loadRoutesConfig: vi.fn(() => loadRoutesConfig()),
      loadFactoryConfigForRepo,
    };
    const setCodexSandbox = vi.spyOn(ModelRouter.prototype, 'setCodexSandbox');
    newRepoRouter(root, loaders, ModelRouter);
    expect(setCodexSandbox).toHaveBeenCalledWith(undefined);
  });
});
