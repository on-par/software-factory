import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTempDirs } from '../harness/temp-dir.js';
import { adaptV1ToV2, loadRepoConfig, RepoFactoryConfigV1Schema, RepoFactoryConfigV2Schema } from './repo.js';

const tmp = createTempDirs();
afterEach(() => tmp.cleanup());
function repo(config: unknown): string {
  const root = tmp.makeSync('repo-commands-');
  mkdirSync(join(root, '.factory'));
  writeFileSync(join(root, '.factory', 'config.json'), JSON.stringify(config));
  return root;
}

describe('repo commands config', () => {
  it('accepts commands in both schemas and preserves them through V1 adaptation and loading', () => {
    const commands = { audit: 'node scripts/audit.mjs' };
    expect(RepoFactoryConfigV1Schema.parse({ version: 1, commands }).commands).toEqual(commands);
    expect(RepoFactoryConfigV2Schema.parse({ version: 2, commands }).commands).toEqual(commands);
    expect(adaptV1ToV2({ version: 1, commands }).commands).toEqual(commands);
    expect(loadRepoConfig(repo({ version: 1, commands }))?.commands).toEqual(commands);
    expect(loadRepoConfig(repo({ version: 2, commands }))?.commands).toEqual(commands);
  });

  it('keeps omission and empty maps valid while rejecting non-strings and unknown keys', () => {
    expect(RepoFactoryConfigV1Schema.parse({ version: 1 }).commands).toBeUndefined();
    expect(RepoFactoryConfigV2Schema.parse({ version: 2 }).commands).toBeUndefined();
    expect(RepoFactoryConfigV2Schema.parse({ version: 2, commands: {} }).commands).toEqual({});
    expect(RepoFactoryConfigV2Schema.safeParse({ version: 2, commands: { bad: 1 } }).success).toBe(false);
    expect(RepoFactoryConfigV2Schema.safeParse({ version: 2, unknown: true }).success).toBe(false);
  });
});
