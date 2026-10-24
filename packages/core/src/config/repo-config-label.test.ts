// src/config/repo-config-label.test.ts — validation errors name the repo config file that was loaded (#3604)

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import { ModelRegistry } from '../models/index.js';
import { loadModelsConfig } from './index.js';
import { applyRepoConfig, loadRepoConfig, resolveEffectiveModelPins } from './repo.js';

const tempDirs = createTempDirs();

async function repoWith(file: string, contents: string): Promise<string> {
  const root = await tempDirs.make('repo-config-label-');
  await mkdir(join(root, '.factory'), { recursive: true });
  await writeFile(join(root, '.factory', file), contents);
  return root;
}

afterEach(() => tempDirs.cleanup());

describe('repo config file label (#3604)', () => {
  it('models config errors name the loaded yaml file', async () => {
    const root = await repoWith(
      'config.yaml',
      "version: 2\nmodels:\n  providerOrder:\n    boss: ['opencode/claude-sonnet-4']\n",
    );
    expect(() => applyRepoConfig(loadModelsConfig(), loadRepoConfig(root))).toThrow(
      /^\.factory\/config\.yaml: models\.providerOrder\.boss\[0\]/,
    );
    const pinned = await repoWith('config.yaml', 'version: 2\nmodels:\n  pins:\n    plan: no-such-model\n');
    const registry = new ModelRegistry(loadModelsConfig());
    expect(() => resolveEffectiveModelPins(registry, loadRepoConfig(pinned), {})).toThrow(
      /^\.factory\/config\.yaml: models\.pins\.plan/,
    );
  });

  it('names config.yml for a yml repo and config.json for a json repo', async () => {
    const yml = await repoWith('config.yml', 'version: 2\ntiers:\n  worker: [nope]\n');
    expect(() => applyRepoConfig(loadModelsConfig(), loadRepoConfig(yml))).toThrow(/^\.factory\/config\.yml: tier/);
    const json = await repoWith('config.json', '{"version":2,"tiers":{"worker":["nope"]}}');
    expect(() => applyRepoConfig(loadModelsConfig(), loadRepoConfig(json))).toThrow(/^\.factory\/config\.json: tier/);
  });
});
