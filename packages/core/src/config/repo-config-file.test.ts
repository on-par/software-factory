import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getFactoryPaths, loadFactoryConfigForRepo } from './index.js';
import { resolveSafeRepoPolicy } from './policy.js';
import {
  migrateRepoConfigToYaml,
  readRepoConfigFile,
  REPO_CONFIG_YAML_HEADER,
  resolveRepoConfigPath,
  setRepoConfigValue,
} from './repo-config-file.js';
import { loadRepoConfig } from './repo.js';
import { loadV2Config } from './v2.js';

const YAML_TEXT = '# why we pin\nversion: 2\nmerge:\n  auto: true # human-free\n';
const EXPECTED = { version: 2, merge: { auto: true } };

describe('repo-config-file', () => {
  let root: string;
  let factory: string;
  const write = (name: string, text: string): string => {
    const p = join(factory, name);
    writeFileSync(p, text);
    return p;
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'factory-repo-config-'));
    factory = join(root, '.factory');
    mkdirSync(factory, { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  describe('resolveRepoConfigPath', () => {
    it('defaults to config.yaml when none exists', () => {
      expect(resolveRepoConfigPath(factory)).toBe(join(factory, 'config.yaml'));
      expect(getFactoryPaths(root).config).toBe(join(factory, 'config.yaml'));
    });
    it('picks whichever exists, preferring yaml, yml, json', () => {
      write('config.json', '{}');
      expect(resolveRepoConfigPath(factory)).toBe(join(factory, 'config.json'));
      write('config.yml', '{}');
      expect(resolveRepoConfigPath(factory)).toBe(join(factory, 'config.yml'));
      write('config.yaml', '{}');
      expect(resolveRepoConfigPath(factory)).toBe(join(factory, 'config.yaml'));
    });
  });

  describe('readRepoConfigFile', () => {
    it('returns undefined when missing', () => {
      expect(readRepoConfigFile(join(factory, 'config.yaml'))).toBeUndefined();
    });
    it('reads commented yaml and yml equal to json', () => {
      const y = write('config.yaml', YAML_TEXT);
      expect(readRepoConfigFile(y)).toEqual(EXPECTED);
      rmSync(y);
      expect(readRepoConfigFile(write('config.yml', YAML_TEXT))).toEqual(EXPECTED);
      rmSync(join(factory, 'config.yml'));
      expect(readRepoConfigFile(write('config.json', JSON.stringify(EXPECTED)))).toEqual(EXPECTED);
    });
    it('throws naming both files when more than one exists', () => {
      const y = write('config.yaml', YAML_TEXT);
      const j = write('config.json', '{}');
      expect(() => readRepoConfigFile(y)).toThrow(new RegExp(`${y}.*${j}`));
      expect(() => loadRepoConfig(root)).toThrow(/Multiple repo config files/);
    });
    it('reports malformed yaml with path and line', () => {
      const y = write('config.yaml', 'models:\n  pins: [unclosed');
      expect(() => readRepoConfigFile(y)).toThrow(new RegExp(`Failed to parse ${y} \\(line \\d+\\)`));
    });
    it('keeps the json error prefix', () => {
      const j = write('config.json', '{nope');
      expect(() => readRepoConfigFile(j)).toThrow(`Failed to parse ${j}:`);
    });
    it('skips the collision check for non-candidate names', () => {
      write('config.yaml', YAML_TEXT);
      expect(readRepoConfigFile(write('foo.json', '{"a":1}'))).toEqual({ a: 1 });
    });
  });

  describe('loaders', () => {
    it('all read a commented config.yaml', () => {
      const p = write('config.yaml', YAML_TEXT);
      expect(loadRepoConfig(root)).toMatchObject({ version: 2 });
      expect(loadFactoryConfigForRepo(p).merge.auto).toBe(true);
      expect(resolveSafeRepoPolicy(p)).toBeDefined();
      expect(loadV2Config(p).version).toBe(2);
    });
    it('rejects an empty yaml document', () => {
      const p = write('config.yaml', '# nothing\n');
      expect(() => loadFactoryConfigForRepo(p)).toThrow(/expected a JSON object/);
    });
    it('loadV2Config throws on a missing file', () => {
      expect(() => loadV2Config(join(factory, 'config.yaml'))).toThrow(/file not found/);
    });
  });

  describe('setRepoConfigValue', () => {
    it('edits YAML in place, keeping comments', () => {
      const p = write('config.yaml', YAML_TEXT);
      setRepoConfigValue(p, ['merge', 'auto'], false);
      expect(readFileSync(p, 'utf-8')).toBe(YAML_TEXT.replace('true', 'false'));
    });
    it('handles .yml', () => {
      const p = write('config.yml', YAML_TEXT);
      setRepoConfigValue(p, ['merge', 'auto'], false);
      expect(readRepoConfigFile(p)).toEqual({ version: 2, merge: { auto: false } });
    });
    it('fills an empty YAML file', () => {
      const p = write('config.yaml', '');
      setRepoConfigValue(p, ['merge', 'auto'], true);
      expect(readRepoConfigFile(p)).toEqual(EXPECTED);
    });
    it('replaces a non-map parent', () => {
      const p = write('config.yaml', 'version: 2\nmerge: 5\n');
      setRepoConfigValue(p, ['merge', 'auto'], true);
      expect(readRepoConfigFile(p)).toEqual(EXPECTED);
    });
    it('throws on malformed YAML', () => {
      const p = write('config.yaml', 'a: [1\n');
      expect(() => setRepoConfigValue(p, ['a'], 1)).toThrow('Failed to parse');
    });
    it('writes JSON as two-space JSON', () => {
      const p = write('config.json', '{"version":2}');
      setRepoConfigValue(p, ['merge', 'auto'], true);
      expect(readFileSync(p, 'utf-8')).toBe(`${JSON.stringify(EXPECTED, null, 2)}\n`);
    });
    it('rejects a non-object JSON file', () => {
      const p = write('config.json', '[1]');
      expect(() => setRepoConfigValue(p, ['a'], 1)).toThrow('expected a JSON object');
    });
    it('creates an absent JSON file with version 2', () => {
      const p = join(factory, 'config.json');
      setRepoConfigValue(p, ['merge', 'auto'], true);
      expect(readRepoConfigFile(p)).toEqual(EXPECTED);
    });
  });

  describe('migrateRepoConfigToYaml', () => {
    const json = JSON.stringify(EXPECTED);
    it('converts config.json to config.yaml and removes the JSON', () => {
      write('config.json', json);
      const r = migrateRepoConfigToYaml(factory);
      expect(r.status).toBe('migrated');
      expect(existsSync(join(factory, 'config.json'))).toBe(false);
      const yamlPath = join(factory, 'config.yaml');
      expect(readRepoConfigFile(yamlPath)).toEqual(EXPECTED);
      expect(readFileSync(yamlPath, 'utf-8').startsWith(REPO_CONFIG_YAML_HEADER)).toBe(true);
    });
    it('dry run writes nothing', () => {
      write('config.json', json);
      expect(migrateRepoConfigToYaml(factory, { dryRun: true }).status).toBe('would-migrate');
      expect(existsSync(join(factory, 'config.yaml'))).toBe(false);
      expect(existsSync(join(factory, 'config.json'))).toBe(true);
    });
    it('reports no-config and already-yaml', () => {
      expect(migrateRepoConfigToYaml(factory).status).toBe('no-config');
      write('config.yaml', YAML_TEXT);
      expect(migrateRepoConfigToYaml(factory)).toEqual({ status: 'already-yaml', path: join(factory, 'config.yaml') });
    });
    it('reports already-yaml for config.yml', () => {
      write('config.yml', YAML_TEXT);
      expect(migrateRepoConfigToYaml(factory).status).toBe('already-yaml');
    });
    it('throws when both files exist and deletes nothing', () => {
      write('config.json', json);
      write('config.yaml', YAML_TEXT);
      expect(() => migrateRepoConfigToYaml(factory)).toThrow('Multiple repo config files');
      expect(existsSync(join(factory, 'config.json'))).toBe(true);
      expect(existsSync(join(factory, 'config.yaml'))).toBe(true);
    });
    it('keeps the JSON and removes the YAML when the read-back differs', () => {
      write('config.json', json);
      const r = migrateRepoConfigToYaml(factory, { parse: () => ({ version: 3 }) });
      expect(r.status).toBe('round-trip-failed');
      expect(readFileSync(join(factory, 'config.json'), 'utf-8')).toBe(json);
      expect(existsSync(join(factory, 'config.yaml'))).toBe(false);
    });
    it('treats a throwing read-back as a failure', () => {
      write('config.json', json);
      const r = migrateRepoConfigToYaml(factory, {
        parse: () => {
          throw new Error('boom');
        },
      });
      expect(r).toMatchObject({ status: 'round-trip-failed', reason: 'boom' });
      expect(existsSync(join(factory, 'config.json'))).toBe(true);
    });
  });
});
