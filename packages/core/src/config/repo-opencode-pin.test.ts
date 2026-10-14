import { describe, expect, it } from 'vitest';

import { ModelRegistry } from '../models/index.js';
import { loadModelsConfig } from './index.js';
import { resolveEffectiveModelPins } from './repo.js';

describe('OpenCode DeepSeek V4 Pro repo pin (#2898)', () => {
  const shippedRegistry = new ModelRegistry(loadModelsConfig());

  it('accepts a repo plan pin to opencode-deepseek-v4-pro', () => {
    const result = resolveEffectiveModelPins(
      shippedRegistry,
      { version: 2, models: { pins: { plan: 'opencode-deepseek-v4-pro' } } },
      {},
    );
    expect(result).toEqual({ plan: 'opencode-deepseek-v4-pro', build: undefined, sources: { plan: 'repo' } });
  });
});
