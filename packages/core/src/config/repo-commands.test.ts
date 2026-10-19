import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { adaptV1ToV2, loadRepoConfig, RepoFactoryConfigV1Schema, RepoFactoryConfigV2Schema } from './repo.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function repo(config: unknown): string {
  const root = mkdtempSync(join(tmpdir(), 'repo-commands-'));
  dirs.push(root);
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
