import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getFactoryPaths, loadModelsConfig } from './index.js';

describe('getFactoryPaths', () => {
  it('stages triage output alongside the live queue path', () => {
    const repoRoot = '/tmp/some-repo';
    const paths = getFactoryPaths(repoRoot);
    expect(paths.queue).toBe(resolve(repoRoot, '.factory', 'queue'));
    expect(paths.queueProposed).toBe(resolve(repoRoot, '.factory', 'queue.proposed'));
    expect(paths.mergeLock).toBe(resolve(repoRoot, '.factory', 'merge.lock'));
    expect(paths.gitLock).toBe(resolve(repoRoot, '.factory', 'git.lock'));
  });
});

describe('loadModelsConfig', () => {
  it('parses the shipped models.json without throwing', () => {
    expect(() => loadModelsConfig()).not.toThrow();
  });

  it('lists every model referenced by a tier in the models map', () => {
    const config = loadModelsConfig();
    for (const models of Object.values(config.tiers)) {
      for (const modelId of models) {
        expect(config.models[modelId]).toBeDefined();
      }
    }
  });

  it('routes to only real, non-experimental models by default', () => {
    const config = loadModelsConfig();
    const nonExperimental = Object.entries(config.models)
      .filter(([, def]) => !def.experimental)
      .map(([id]) => id)
      .sort();
    expect(nonExperimental).toEqual(['claude-opus-4-8', 'claude-sonnet-5', 'gpt-5.1-codex'].sort());
  });
});
