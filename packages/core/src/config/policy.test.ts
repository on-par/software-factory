import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getFactoryPaths } from './index.js';
import { loadRepoConfig } from './repo.js';
import { readRepoConfigFile } from './repo-config-file.js';
import {
  isSafePolicyFieldId,
  policyConfirmationFor,
  PolicyConfirmationRequiredError,
  resolveSafeRepoPolicy,
  setSafeRepoPolicyField,
} from './policy.js';

describe('config/policy', () => {
  let dir: string;
  let configPath: string;
  let yamlPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'factory-policy-'));
    yamlPath = getFactoryPaths(dir).config;
    configPath = join(dirname(yamlPath), 'config.json');
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

      const snapshot = setSafeRepoPolicyField(configPath, 'merge.auto', true, { env: {} });

      expect(snapshot.fields[0]).toMatchObject({ value: true, source: 'config' });
      const onDisk = JSON.parse(await readFile(configPath, 'utf-8'));
      expect(onDisk.models).toEqual({ pins: { build: 'claude-sonnet-5' } });
      expect(onDisk.tiers).toEqual({ worker: ['a'] });
      expect(onDisk.merge.auto).toBe(true);
    });

    it('preserves a sibling merge.comment key', async () => {
      await writeFile(configPath, JSON.stringify({ version: 2, merge: { auto: false, comment: 'keep me' } }));

      setSafeRepoPolicyField(configPath, 'merge.auto', true, { env: {} });

      const onDisk = JSON.parse(await readFile(configPath, 'utf-8'));
      expect(onDisk.merge).toEqual({ auto: true, comment: 'keep me' });
    });

    it('creates a minimal version:2 file when none exists, still parseable by loadRepoConfig', () => {
      setSafeRepoPolicyField(configPath, 'merge.auto', true, { env: {} });

      const onDisk = JSON.parse(readFileSync(configPath, 'utf-8'));
      expect(onDisk.version).toBe(2);
      expect(onDisk.merge.auto).toBe(true);
      expect(loadRepoConfig(dir)).not.toBeNull();
    });

    describe('merge.admin confirmation gate', () => {
      it('policyConfirmationFor returns undefined for merge.auto regardless of value', () => {
        expect(policyConfirmationFor('merge.auto', true)).toBeUndefined();
        expect(policyConfirmationFor('merge.auto', false)).toBeUndefined();
      });

      it('policyConfirmationFor returns a spec for enabling merge.admin, undefined for disabling', () => {
        expect(policyConfirmationFor('merge.admin', true)).toEqual({
          token: 'ENABLE_ADMIN_MERGE_BYPASS',
          auditText: expect.stringContaining('admin-merge bypass explicitly enabled'),
        });
        expect(policyConfirmationFor('merge.admin', false)).toBeUndefined();
      });

      it('throws PolicyConfirmationRequiredError and writes nothing when enabling without a token', () => {
        expect(() => setSafeRepoPolicyField(configPath, 'merge.admin', true, { env: {} })).toThrow(
          PolicyConfirmationRequiredError,
        );
        expect(existsSync(configPath)).toBe(false);
      });

      it('throws when the token does not match', () => {
        expect(() =>
          setSafeRepoPolicyField(configPath, 'merge.admin', true, { env: {}, confirmationToken: 'wrong' }),
        ).toThrow(PolicyConfirmationRequiredError);
        expect(existsSync(configPath)).toBe(false);
      });

      it('writes run.merge.admin when the token matches', () => {
        const snapshot = setSafeRepoPolicyField(configPath, 'merge.admin', true, {
          env: {},
          confirmationToken: 'ENABLE_ADMIN_MERGE_BYPASS',
        });

        const field = snapshot.fields.find((f) => f.id === 'merge.admin');
        expect(field).toMatchObject({ value: true, source: 'config' });
        const onDisk = JSON.parse(readFileSync(configPath, 'utf-8'));
        expect(onDisk.run.merge.admin).toBe(true);
      });

      it('disables without a confirmation token (one-click, per #1390 scope)', () => {
        setSafeRepoPolicyField(configPath, 'merge.admin', true, {
          env: {},
          confirmationToken: 'ENABLE_ADMIN_MERGE_BYPASS',
        });

        const snapshot = setSafeRepoPolicyField(configPath, 'merge.admin', false, { env: {} });

        const field = snapshot.fields.find((f) => f.id === 'merge.admin');
        expect(field).toMatchObject({ value: false, source: 'config' });
      });
    });
  });

  describe('resolveSafeRepoPolicy for merge.admin', () => {
    it('reports the packaged default (false) with no config file and no env', () => {
      const snapshot = resolveSafeRepoPolicy(configPath, {});
      const field = snapshot.fields.find((f) => f.id === 'merge.admin');
      expect(field).toMatchObject({
        value: false,
        source: 'default',
        confirmEnable: { token: 'ENABLE_ADMIN_MERGE_BYPASS' },
      });
    });

    it('reports run.merge.admin from config when present', async () => {
      await writeFile(configPath, JSON.stringify({ version: 2, run: { merge: { admin: true } } }));
      const snapshot = resolveSafeRepoPolicy(configPath, {});
      const field = snapshot.fields.find((f) => f.id === 'merge.admin');
      expect(field).toMatchObject({ value: true, source: 'config', sourceDetail: 'run.merge.admin' });
    });

    it('a present config value wins over FACTORY_MERGE_ADMIN=1 (opposite precedence from merge.auto)', async () => {
      await writeFile(configPath, JSON.stringify({ version: 2, run: { merge: { admin: false } } }));
      const snapshot = resolveSafeRepoPolicy(configPath, { FACTORY_MERGE_ADMIN: '1' });
      const field = snapshot.fields.find((f) => f.id === 'merge.admin');
      expect(field).toMatchObject({ value: false, source: 'config' });
    });

    it('FACTORY_MERGE_ADMIN=1 forces true when no config value is present, and is not editable', () => {
      const snapshot = resolveSafeRepoPolicy(configPath, { FACTORY_MERGE_ADMIN: '1' });
      const field = snapshot.fields.find((f) => f.id === 'merge.admin');
      expect(field).toMatchObject({
        value: true,
        source: 'env',
        sourceDetail: 'env: FACTORY_MERGE_ADMIN=1',
        editable: false,
      });
    });
  });

  describe('isSafePolicyFieldId', () => {
    it('is true for merge.auto and merge.admin', () => {
      expect(isSafePolicyFieldId('merge.auto')).toBe(true);
      expect(isSafePolicyFieldId('merge.admin')).toBe(true);
      expect(isSafePolicyFieldId('')).toBe(false);
      expect(isSafePolicyFieldId(42)).toBe(false);
    });
  });

  describe('setSafeRepoPolicyField in a YAML repo', () => {
    it('changes only the edited value and keeps every comment', async () => {
      const input = [
        '# my repo config',
        'version: 2',
        '',
        'sweep:',
        '  # keep this',
        '  limit: 3',
        '',
        'merge:',
        '  auto: false # flip me',
        '',
      ].join('\n');
      await writeFile(yamlPath, input);
      setSafeRepoPolicyField(yamlPath, 'merge.auto', true, { env: {} });
      expect(readFileSync(yamlPath, 'utf-8')).toBe(input.replace('false', 'true'));
    });

    it('creates missing parent maps and keeps existing comments', async () => {
      await writeFile(yamlPath, '# header\nversion: 2\n');
      setSafeRepoPolicyField(yamlPath, 'merge.admin', true, {
        env: {},
        confirmationToken: 'ENABLE_ADMIN_MERGE_BYPASS',
      });
      const text = readFileSync(yamlPath, 'utf-8');
      expect(text).toContain('# header');
      expect((readRepoConfigFile(yamlPath) as any).run.merge.admin).toBe(true);
    });

    it('creates config.yaml (not JSON) when there is no config file', () => {
      setSafeRepoPolicyField(yamlPath, 'merge.auto', true, { env: {} });
      expect(yamlPath.endsWith('config.yaml')).toBe(true);
      expect(readFileSync(yamlPath, 'utf-8').startsWith('{')).toBe(false);
      expect(loadRepoConfig(dir)).not.toBeNull();
      expect((readRepoConfigFile(yamlPath) as any).version).toBe(2);
    });

    it('keeps a JSON repo as JSON and creates no YAML file', async () => {
      await writeFile(configPath, JSON.stringify({ version: 2 }));
      setSafeRepoPolicyField(configPath, 'merge.auto', true, { env: {} });
      const text = readFileSync(configPath, 'utf-8');
      expect(text).toBe(`${JSON.stringify({ version: 2, merge: { auto: true } }, null, 2)}\n`);
      expect(existsSync(yamlPath)).toBe(false);
    });
  });
});
