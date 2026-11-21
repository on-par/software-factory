import { describe, expect, it } from 'vitest';

import { ModelRegistry } from '../models/index.js';
import { ROUTE_BULLETS, runnableBuildRoutes } from '../phases/plan-routes.js';
import { ModelRouter } from '../router/index.js';
import { StubModelExecutor } from '../router/stub.js';
import { loadModelsConfig, loadRoutesConfig } from './index.js';
import { decideBuildRoute, routeForBuildModel } from './build-route.js';
import { RepoFactoryConfigV2Schema } from './repo.js';

describe('copilot build route', () => {
  const registry = new ModelRegistry(loadModelsConfig());

  it('derives route copilot from a copilot-default build pin', () => {
    expect(routeForBuildModel(registry, 'copilot-default')).toBe('copilot');
    expect(decideBuildRoute(registry, { buildPin: 'copilot-default' })).toEqual({
      route: 'copilot',
      source: 'build-pin',
    });
  });

  it('accepts route: copilot in a repo config', () => {
    expect(RepoFactoryConfigV2Schema.parse({ version: 2, route: 'copilot' }).route).toBe('copilot');
  });

  it('is pin-only: build_copilot resolves no model from the default tiers', () => {
    const router = new ModelRouter(loadModelsConfig(), loadRoutesConfig(), false, new StubModelExecutor(), true);
    expect(router.resolveAll('build_copilot')).toEqual([]);
    expect(runnableBuildRoutes(router)).not.toContain('copilot');
  });

  it('is runnable once the worker tier names copilot-default, and only copilot-cli models qualify', () => {
    const base = loadModelsConfig();
    const models = { ...base, tiers: { ...base.tiers, worker: ['copilot-default', 'claude-sonnet-5'] } };
    const router = new ModelRouter(models, loadRoutesConfig(), false, new StubModelExecutor(), true);
    expect(router.resolveAll('build_copilot')).toEqual(['copilot-default']);
    expect(runnableBuildRoutes(router)).toContain('copilot');
    expect(ROUTE_BULLETS.copilot).toContain('route: copilot');
  });
});
