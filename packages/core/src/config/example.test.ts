import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ModelRegistry } from '../models/index.js';
import { CONFIG_EXAMPLE_OMITTED_KEYS, renderConfigExample } from './example.js';
import {
  FACTORY_RUNTIME_CONFIG_KEYS,
  getFactoryPaths,
  loadFactoryConfigForRepo,
  loadModelsConfig,
  resolveMergePolicy,
} from './index.js';
import {
  applyRepoConfig,
  loadRepoConfig,
  RepoFactoryConfigV2Schema,
  resolveCodexDisabled,
  resolveEffectiveBuildRoute,
  resolveEffectiveModelPins,
  resolveEfficiencyPolicy,
  resolveUsageCap,
  resolveWatchdogPolicy,
} from './repo.js';

const EXAMPLE_PATH = fileURLToPath(new URL('../../../../docs/config.example.jsonc', import.meta.url));

/** The example with its `//` comment lines removed: the plain JSON a repo could commit. */
function stripComments(text: string): string {
  return text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** A throwaway repo whose `.factory/config.json` is the stripped example. */
function repoWithExample(): string {
  const repoRoot = mkdtempSync(join(tmpdir(), 'factory-config-example-'));
  tempDirs.push(repoRoot);
  mkdirSync(join(repoRoot, '.factory'), { recursive: true });
  writeFileSync(getFactoryPaths(repoRoot).config, stripComments(renderConfigExample()));
  return repoRoot;
}

const modelKeys = Object.keys(
  (z.toJSONSchema(RepoFactoryConfigV2Schema, { io: 'input' }) as { properties: Record<string, unknown> }).properties,
);
const acceptedTopLevelKeys = [...modelKeys, ...FACTORY_RUNTIME_CONFIG_KEYS];

describe('docs/config.example.jsonc', () => {
  it('matches the generator output', () => {
    expect(
      readFileSync(EXAMPLE_PATH, 'utf-8'),
      'docs/config.example.jsonc is stale — regenerate it with `npm run build && npm run config-example`',
    ).toBe(renderConfigExample());
  });

  it('parses as JSON once comment lines are removed', () => {
    expect(() => JSON.parse(stripComments(renderConfigExample()))).not.toThrow();
  });

  it('renders or deliberately omits every top-level key the loaders accept', () => {
    // Top-level keys sit at two-space indent, live or commented out (e.g. `  // "route": ...`).
    const rendered = [...renderConfigExample().matchAll(/^ {2}(?:\/\/ )?"([^"]+)":/gm)].map((m) => m[1]);
    const missing = acceptedTopLevelKeys.filter(
      (key) => !rendered.includes(key) && !(key in CONFIG_EXAMPLE_OMITTED_KEYS),
    );
    expect(missing).toEqual([]);
  });

  it('only omits keys the loaders actually accept', () => {
    expect(Object.keys(CONFIG_EXAMPLE_OMITTED_KEYS).filter((key) => !acceptedTopLevelKeys.includes(key))).toEqual([]);
  });
});

describe('the example, loaded as a repo config, behaves like no config file', () => {
  const repoRoot = repoWithExample();
  const noConfig = join(repoRoot, 'missing', 'config.json');
  const envs: NodeJS.ProcessEnv[] = [
    {},
    {
      FACTORY_USAGE_CAP: '50',
      FACTORY_STOP_AT: '0.5',
      FACTORY_RESUME_AT: '0.4',
      FACTORY_USAGE_POLL: '30',
      FACTORY_USAGE_WATCH: '0',
      FACTORY_USAGE_ESTIMATOR: '1',
      FACTORY_CODEX: '0',
      FACTORY_MERGE: '1',
      FACTORY_MERGE_ADMIN: '1',
    },
  ];

  it('loads through both the model-routing and the runtime-policy loaders', () => {
    expect(loadRepoConfig(repoRoot)).not.toBeNull();
    expect(() => loadFactoryConfigForRepo(getFactoryPaths(repoRoot).config)).not.toThrow();
  });

  it('keeps every runtime-policy value at its packaged default', () => {
    const { run: _run, ...fromExample } = loadFactoryConfigForRepo(getFactoryPaths(repoRoot).config);
    const { run: _none, ...defaults } = loadFactoryConfigForRepo(noConfig);
    expect(fromExample).toEqual(defaults);
  });

  it.each(envs)('leaves every resolver unchanged (env %o)', (env) => {
    const repo = loadRepoConfig(repoRoot);
    const models = loadModelsConfig();
    const registry = new ModelRegistry(models);
    const pinEnv = { ...env, FACTORY_PLAN_MODEL: registry.list()[0] };

    expect(resolveUsageCap(repo, env)).toEqual(resolveUsageCap(null, env));
    expect(resolveWatchdogPolicy(repo, env)).toEqual(resolveWatchdogPolicy(null, env));
    expect(resolveEfficiencyPolicy(repo)).toEqual(resolveEfficiencyPolicy(null));
    expect(resolveCodexDisabled(repo, env)).toBe(resolveCodexDisabled(null, env));
    expect(applyRepoConfig(models, repo)).toEqual(models);
    const pins = resolveEffectiveModelPins(registry, repo, pinEnv);
    expect(pins).toEqual(resolveEffectiveModelPins(registry, null, pinEnv));
    expect(resolveEffectiveBuildRoute(registry, repo, pins)).toEqual(resolveEffectiveBuildRoute(registry, null, pins));
    expect(resolveMergePolicy(loadFactoryConfigForRepo(getFactoryPaths(repoRoot).config), env)).toEqual(
      resolveMergePolicy(loadFactoryConfigForRepo(noConfig), env),
    );
  });
});
