import { defaultModelsConfig } from '@on-par/factory-config';
import { describe, expect, it } from 'vitest';

import { loadModelsConfig } from './index.js';
import { applyRepoConfig, type RepoFactoryConfig } from './repo.js';

const repoWith = (providerOrder: Record<string, string[]>) =>
  ({ version: 2, models: { providerOrder } }) as RepoFactoryConfig;

describe('applyRepoConfig models.providerOrder (#3334)', () => {
  it('accepts a checker override and defaults the other roles', () => {
    const result = applyRepoConfig(loadModelsConfig(), repoWith({ checker: ['gpt-5.6-luna-high'] }));
    expect(result.providerOrder).toEqual({
      ...defaultModelsConfig.providerOrder,
      checker: ['gpt-5.6-luna-high'],
    });
  });

  it('throws for a Zen entry, naming the path', () => {
    expect(() => applyRepoConfig(loadModelsConfig(), repoWith({ worker: ['opencode/claude-sonnet-5'] }))).toThrow(
      /^\.factory\/config\.json: models\.providerOrder\.worker\[0\].*OpenCode Zen/,
    );
  });
});

describe('loadModelsConfig packaged defaults (#3334)', () => {
  it('carries providerOrder and ships no OpenCode Zen model', () => {
    const config = loadModelsConfig();
    expect(config.providerOrder).toEqual(defaultModelsConfig.providerOrder);
    for (const [id, def] of Object.entries(config.models)) {
      expect(`${id} ${def.providerModel ?? ''}`).not.toMatch(/(^| )opencode\//);
    }
  });
});
