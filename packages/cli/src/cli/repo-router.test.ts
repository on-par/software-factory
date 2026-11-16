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
  sandboxes.length = 0;
  await dirs.cleanup();
});

const sandboxes: unknown[] = [];
class RecordingRouter extends ModelRouter {
  override setCodexSandbox(...a: Parameters<ModelRouter['setCodexSandbox']>) {
    sandboxes.push(a[0]);
    super.setCodexSandbox(...a);
  }
}

describe('newRepoRouter', () => {
  it('builds the router from the given loaders, applying the repo sandbox and local-auth sink', () => {
    const models = loadModelsConfig();
    const routes = loadRoutesConfig();
    const factory = loadFactoryConfig();
    const loaders: RepoRouterLoaders = {
      loadRepoConfig: (root) => (repoRoots.push(root), null),
      loadModelsConfig: () => models,
      loadRoutesConfig: () => routes,
      loadFactoryConfigForRepo: (path) => (
        configPaths.push(path),
        { ...factory, sandbox: { ...factory.sandbox, codexFullAccessTasks: ['build_codex'] } }
      ),
    };
    const repoRoots: string[] = [];
    const configPaths: string[] = [];
    const fullAccess: unknown[] = [];
    const sinks: unknown[] = [];
    const constructed: ConstructorParameters<typeof ModelRouter>[] = [];
    class SpyRouter extends ModelRouter {
      constructor(...args: ConstructorParameters<typeof ModelRouter>) {
        super(...args);
        constructed.push(args);
      }
      override setCodexFullAccessTasks(...a: Parameters<ModelRouter['setCodexFullAccessTasks']>) {
        fullAccess.push(a[0]);
        super.setCodexFullAccessTasks(...a);
      }
      override setLocalAuthSink(...a: Parameters<ModelRouter['setLocalAuthSink']>) {
        sinks.push(a[0]);
        super.setLocalAuthSink(...a);
      }
    }

    const router = newRepoRouter('/repo', loaders, SpyRouter);

    expect(router).toBeInstanceOf(SpyRouter);
    expect(repoRoots).toEqual(['/repo']);
    expect(configPaths).toEqual([getFactoryPaths('/repo').config]);
    expect(constructed).toHaveLength(1);
    const [modelsArg, routesArg, verbose, executor, allowExperimental, localOnly] = constructed[0]!;
    expect(modelsArg).toBe(models);
    expect(routesArg).toBe(routes);
    expect(verbose).toBe(false);
    expect(executor).toBeUndefined();
    expect(typeof allowExperimental).toBe('boolean');
    expect(typeof localOnly).toBe('boolean');
    expect(fullAccess).toEqual([['build_codex']]);
    expect(sinks).toEqual([recordLocalAuthFailure]);
  });

  it('passes sandbox.codexSandbox to setCodexSandbox (#3830)', () => {
    const factory = loadFactoryConfig();
    const loaders: RepoRouterLoaders = {
      loadRepoConfig: () => null,
      loadModelsConfig,
      loadRoutesConfig,
      loadFactoryConfigForRepo: () => ({
        ...factory,
        sandbox: { ...factory.sandbox, codexSandbox: 'workspace-write' as const },
      }),
    };
    newRepoRouter('/repo', loaders, RecordingRouter);
    expect(sandboxes).toEqual(['workspace-write']);
  });

  it('an unknown sandbox.codexSandbox in config reaches setCodexSandbox as undefined (#3830)', () => {
    const root = dirs.makeSync('repo-router-');
    const configPath = getFactoryPaths(root).config;
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, 'sandbox:\n  codexSandbox: read-only\n');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const loaders: RepoRouterLoaders = {
      loadRepoConfig: () => null,
      loadModelsConfig,
      loadRoutesConfig,
      loadFactoryConfigForRepo,
    };
    newRepoRouter(root, loaders, RecordingRouter);
    expect(sandboxes).toEqual([undefined]);
  });
});
