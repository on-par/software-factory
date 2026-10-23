import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTempDirs } from '../harness/temp-dir.js';
import { getFactoryPaths, loadFactoryConfigForRepo } from './index.js';
import { adaptV1ToV2, loadRepoConfig, RepoFactoryConfigV1Schema, RepoFactoryConfigV2Schema } from './repo.js';
import { findConfigSchemaErrors, findUnknownConfigKeyWarnings } from './config-schema-lint.js';

const tmp = createTempDirs();
afterEach(() => tmp.cleanup());

function repo(config: unknown): string {
  const root = tmp.makeSync('repo-pr-footer-');
  mkdirSync(join(root, '.factory'));
  writeFileSync(join(root, '.factory', 'config.json'), JSON.stringify(config));
  return root;
}

describe.each([1, 2])('V%i PR footer config', (version) => {
  const schema = version === 1 ? RepoFactoryConfigV1Schema : RepoFactoryConfigV2Schema;
  it.each(['Custom {{repo}} footer', '', '   '])('accepts and resolves string %j', (footer) => {
    const pr = { footer };
    const raw = { version, pr };
    expect(schema.parse(raw).pr).toEqual(pr);
    expect(adaptV1ToV2({ version: 1, pr }).pr).toEqual(pr);
    const root = repo(raw);
    expect(() => loadRepoConfig(root)).not.toThrow();
    const configPath = getFactoryPaths(root).config;
    expect(loadFactoryConfigForRepo(configPath).pr?.footer).toBe(footer);
    const file = { absPath: configPath, relPath: '.factory/config.json' };
    expect(findConfigSchemaErrors(file)).toEqual([]);
    expect(findUnknownConfigKeyWarnings(file)).toEqual([]);
  });

  it.each([false, 1, null, [], {}])('rejects a non-string footer %j', (footer) => {
    expect(schema.safeParse({ version, pr: { footer } }).success).toBe(false);
    const configPath = getFactoryPaths(repo({ version, pr: { footer } })).config;
    expect(() => loadFactoryConfigForRepo(configPath)).toThrow('pr.footer');
    expect(findConfigSchemaErrors({ absPath: configPath, relPath: '.factory/config.json' })).toContainEqual(
      expect.objectContaining({ path: 'pr.footer' }),
    );
  });

  it.each([{}, { pr: {} }])('uses the default when footer is unset in %j', (overlay) => {
    const config = { version, ...overlay };
    expect(schema.safeParse(config).success).toBe(true);
    const configPath = getFactoryPaths(repo(config)).config;
    expect(loadFactoryConfigForRepo(configPath).pr?.footer).toBe('This PR was made by Software Factory');
  });
});
