import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { createTempDirs, type TempDirs } from '../harness/temp-dir.js';
import { ModelRouter } from '../router/index.js';
import { StubModelExecutor, type StubModelExecutorOptions } from '../router/stub.js';

export { fakeOctokit } from '../harness/fake-octokit.js';

type StubModelEntry = ModelsConfig['models'][string];

export function stubModel(overrides: Partial<StubModelEntry> = {}): StubModelEntry {
  return {
    provider: 'custom',
    tier: 'boss',
    costPerMtokInput: 0,
    costPerMtokOutput: 0,
    contextWindow: 1000,
    capabilities: [],
    envKey: null,
    ...overrides,
  };
}

export function stubModelsConfig(models: ModelsConfig['models'], tiers: ModelsConfig['tiers']): ModelsConfig {
  return {
    version: 1,
    models,
    tiers,
    failover: { triggers: ['rate_limit', 'unavailable', 'auth'], maxRetries: 2, cooldownMs: 0 },
    routingRules: {},
  };
}

export interface PhaseTestSetup {
  tempDirs: TempDirs;
  worktree(prefix?: string): Promise<string>;
  router(
    models: ModelsConfig,
    routes: RoutesConfig,
    scripts?: StubModelExecutorOptions['scripts'],
    executor?: StubModelExecutor,
  ): { router: ModelRouter; stub: StubModelExecutor };
  logger(): { logs: Array<{ type: string; msg: string }>; log: (type: string, msg: string) => void };
  cleanup(): Promise<void>;
}

/** Shared phase-test setup. Callers keep their own `afterEach(() => setup.cleanup())`. */
export function createPhaseTestSetup(): PhaseTestSetup {
  const tempDirs = createTempDirs();
  return {
    tempDirs,
    worktree: (prefix = 'phase-test-') => tempDirs.make(prefix),
    router(models, routes, scripts, executor) {
      const stub = executor ?? new StubModelExecutor({ scripts });
      return { router: new ModelRouter(models, routes, false, stub), stub };
    },
    logger() {
      const logs: Array<{ type: string; msg: string }> = [];
      return { logs, log: (type, msg) => void logs.push({ type, msg }) };
    },
    cleanup: () => tempDirs.cleanup(),
  };
}
