import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getFactoryPaths } from './index.js';
import { loadRepoConfig } from './repo.js';
import { isSafePolicyFieldId, resolveSafeRepoPolicy, setSafeRepoPolicyField } from './policy.js';

describe('config/policy', () => {
  let dir: string;
  let configPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'factory-policy-'));
    configPath = getFactoryPaths(dir).config;
    await mkdir(dirname(configPath), { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe('resolveSafeRepoPolicy', () => {
    it('reports the packaged default when there is no config file and no env', () => {
      const snapshot = resolveSafeRepoPolicy(configPath, {});
      const field = snapshot.fields.find((f) => f.id === 'merge.auto');
      expect(field).toEqual({
        id: 'merge.auto',
        label: 'Auto-merge',
        description: 'Squash-merge a shipped PR automatically once CI is green.',
        value: false,
        source: 'default',
        sourceDetail: 'built-in default',
        editable: true,
      });
      expect(snapshot.configPath).toBe(configPath);
    });

    it('reports source config when the raw key is present and true', async () => {
      await writeFile(configPath, JSON.stringify({ version: 2, merge: { auto: true } }));
      const snapshot = resolveSafeRepoPolicy(configPath, {});
      expect(snapshot.fields[0]).toMatchObject({ value: true, source: 'config', sourceDetail: 'merge.auto' });
    });

    it('distinguishes a config-written false from the packaged default false', async () => {
      await writeFile(configPath, JSON.stringify({ version: 2, merge: { auto: false } }));
      const snapshot = resolveSafeRepoPolicy(configPath, {});
      expect(snapshot.fields[0]).toMatchObject({ value: false, source: 'config' });
    });

    it('FACTORY_MERGE=1 forces true regardless of the config value, and is not editable', async () => {
      await writeFile(configPath, JSON.stringify({ version: 2, merge: { auto: false } }));
      const snapshot = resolveSafeRepoPolicy(configPath, { FACTORY_MERGE: '1' });
      expect(snapshot.fields[0]).toMatchObject({
        value: true,
        source: 'env',
        sourceDetail: 'env: FACTORY_MERGE=1',
        editable: false,
      });
    });

    it('FACTORY_MERGE=0 lets the config value decide (matches the engine read)', async () => {
      await writeFile(configPath, JSON.stringify({ version: 2, merge: { auto: true } }));
      const snapshot = resolveSafeRepoPolicy(configPath, { FACTORY_MERGE: '0' });
      expect(snapshot.fields[0]).toMatchObject({ value: true, source: 'config' });
    });

    it('a flag override wins over env and config, and is not editable', async () => {
      await writeFile(configPath, JSON.stringify({ version: 2, merge: { auto: true } }));
      const snapshot = resolveSafeRepoPolicy(configPath, { FACTORY_MERGE: '1' }, { 'merge.auto': false });
      expect(snapshot.fields[0]).toMatchObject({
        value: false,
        source: 'flag',
        sourceDetail: '--merge',
        editable: false,
      });
    });

    it('throws with the file path in the message on malformed JSON', async () => {
      await writeFile(configPath, 'not json{{{');
      expect(() => resolveSafeRepoPolicy(configPath, {})).toThrow(configPath);
    });
  });

  describe('setSafeRepoPolicyField', () => {
    it('preserves unrelated keys and returns the re-resolved snapshot', async () => {
      await writeFile(
        configPath,
        JSON.stringify({ version: 2, models: { pins: { build: 'claude-sonnet-5' } }, tiers: { worker: ['a'] } }),
      );

      const snapshot = setSafeRepoPolicyField(configPath, 'merge.auto', true, {});

      expect(snapshot.fields[0]).toMatchObject({ value: true, source: 'config' });
      const onDisk = JSON.parse(await readFile(configPath, 'utf-8'));
      expect(onDisk.models).toEqual({ pins: { build: 'claude-sonnet-5' } });
      expect(onDisk.tiers).toEqual({ worker: ['a'] });
      expect(onDisk.merge.auto).toBe(true);
    });

    it('preserves a sibling merge.comment key', async () => {
      await writeFile(configPath, JSON.stringify({ version: 2, merge: { auto: false, comment: 'keep me' } }));

      setSafeRepoPolicyField(configPath, 'merge.auto', true, {});

      const onDisk = JSON.parse(await readFile(configPath, 'utf-8'));
      expect(onDisk.merge).toEqual({ auto: true, comment: 'keep me' });
    });

    it('creates a minimal version:2 file when none exists, still parseable by loadRepoConfig', () => {
      setSafeRepoPolicyField(configPath, 'merge.auto', true, {});

      const onDisk = JSON.parse(readFileSync(configPath, 'utf-8'));
      expect(onDisk.version).toBe(2);
      expect(onDisk.merge.auto).toBe(true);
      expect(loadRepoConfig(dir)).not.toBeNull();
    });
  });

  describe('isSafePolicyFieldId', () => {
    it('is true only for merge.auto', () => {
      expect(isSafePolicyFieldId('merge.auto')).toBe(true);
      expect(isSafePolicyFieldId('merge.admin')).toBe(false);
      expect(isSafePolicyFieldId('')).toBe(false);
      expect(isSafePolicyFieldId(42)).toBe(false);
    });
  });
});
