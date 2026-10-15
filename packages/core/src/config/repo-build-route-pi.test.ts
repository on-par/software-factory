import { describe, expect, it } from 'vitest';

import { ModelRegistry } from '../models/index.js';
import { loadModelsConfig } from './index.js';
import { resolveEffectiveBuildRoute, routeForBuildModel } from './repo.js';

describe('build route from a Pi build pin (#2909)', () => {
  it('resolveEffectiveBuildRoute derives the command route from a Pi build pin (#2909)', () => {
    const registry = new ModelRegistry(loadModelsConfig());
    expect(routeForBuildModel(registry, 'pi-openrouter-deepseek-v4-flash')).toBe('command');
    expect(
      resolveEffectiveBuildRoute(registry, null, {
        build: 'pi-openrouter-deepseek-v4-flash',
        sources: { build: 'repo' },
      }),
    ).toEqual({ route: 'command', source: 'build-pin' });
  });

  it('keeps ollama-http and ollama-agentic models without a build route', () => {
    const base = loadModelsConfig();
    const def = { ...base.models[Object.keys(base.models)[0]], provider: 'ollama' as const };
    const registry = new ModelRegistry({
      ...base,
      models: {
        ...base.models,
        'http-model': { ...def, harness: 'ollama-http' },
        'agentic-model': { ...def, harness: 'ollama-agentic' },
      },
    });
    expect(routeForBuildModel(registry, 'http-model')).toBeUndefined();
    expect(routeForBuildModel(registry, 'agentic-model')).toBeUndefined();
  });
});
