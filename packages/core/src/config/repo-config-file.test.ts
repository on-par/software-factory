import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getFactoryPaths, loadFactoryConfigForRepo } from './index.js';
import { resolveSafeRepoPolicy } from './policy.js';
import { readRepoConfigFile, resolveRepoConfigPath } from './repo-config-file.js';
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
});
