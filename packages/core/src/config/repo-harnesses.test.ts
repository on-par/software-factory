import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadModelsConfig, type ModelsConfig } from './index.js';
import { applyRepoConfig, loadRepoConfig } from './repo.js';

type ModelDef = ModelsConfig['models'][string];

const models = loadModelsConfig();

function baseModel(overrides: Partial<ModelDef> = {}): ModelDef {
  return {
    provider: 'anthropic',
    tier: 'worker',
    costPerMtokInput: 0,
    costPerMtokOutput: 0,
    contextWindow: 1000,
    capabilities: [],
    envKey: null,
    ...overrides,
  };
}

const tempDirs = new Set<string>();
afterEach(async () => {
  await Promise.all([...tempDirs].map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.clear();
});

async function tempRepoRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'repo-harnesses-test-'));
  tempDirs.add(dir);
  return dir;
}

describe('repo harnesses (#2869)', () => {
  const decl = {
    command: 'my-agent',
    prompt: 'stdin',
    output: 'stdout',
    agentic: true,
    usage: 'none',
  } as const;
  const custom = baseModel({ provider: 'custom', tier: 'worker', harness: 'my-agent' });

  it('rejects a repo harness that redeclares a built-in id', () => {
    expect(() => applyRepoConfig(models, { version: 2, harnesses: { 'claude-cli': decl } })).toThrow(
      "Harness 'claude-cli' is built in and cannot be redeclared under harnesses",
    );
  });

  it('accepts a registry model on a repo-declared harness', () => {
    const merged = applyRepoConfig(models, {
      version: 2,
      harnesses: { 'my-agent': decl },
      models: { registry: { 'my-model': custom } },
    });
    expect(merged.harnesses?.['my-agent']).toEqual(decl);
    expect(merged.models['my-model']?.harness).toBe('my-agent');
  });

  it('lists repo-declared harnesses as valid in the unknown-harness error', () => {
    expect(() =>
      applyRepoConfig(models, {
        version: 2,
        harnesses: { 'my-agent': decl },
        models: { registry: { 'my-model': { ...custom, harness: 'nope' } } },
      }),
    ).toThrow(/valid harnesses: .*my-agent/);
  });

  it('keeps packaged harnesses when the repo config declares none', () => {
    expect(applyRepoConfig(loadModelsConfig(), { version: 2 }).harnesses).toEqual(loadModelsConfig().harnesses);
  });

  it('loadRepoConfig names the bad field of a declared harness', async () => {
    const repoRoot = await tempRepoRoot();
    await mkdir(join(repoRoot, '.factory'), { recursive: true });
    await writeFile(
      join(repoRoot, '.factory', 'config.yaml'),
      'version: 2\nharnesses:\n  my-agent:\n    command: my-agent\n    prompt: pipe\n    output: stdout\n    agentic: true\n    usage: none\n',
    );
    expect(() => loadRepoConfig(repoRoot)).toThrow(/harnesses\.my-agent\.prompt/);
    expect(() => loadRepoConfig(repoRoot)).toThrow(/prompt must be one of: stdin, file, arg/);
  });
});
