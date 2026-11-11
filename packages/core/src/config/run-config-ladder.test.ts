import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import { describeConfigSources, resolveConstitutionOverride, resolveRunConfigLadder } from './run-config-ladder.js';

const tmp = createTempDirs();
afterEach(() => tmp.cleanup());

const REPO_YAML = 'version: 2\nchecks:\n  build: make\ndisk:\n  minFreeGb: 10\n  minFreeRatio: 0.1\n';

function repoConfig(text = REPO_YAML): string {
  const dir = tmp.makeSync('ladder-repo-');
  mkdirSync(join(dir, '.factory'));
  const file = join(dir, '.factory', 'config.yaml');
  writeFileSync(file, text);
  return file;
}

function file(name: string, text: string): string {
  const path = join(tmp.makeSync('ladder-file-'), name);
  writeFileSync(path, text);
  return path;
}

describe('resolveRunConfigLadder (#3906)', () => {
  it('uses the repo config file when no override is set', () => {
    const path = repoConfig();
    const ladder = resolveRunConfigLadder(path, {});
    expect(ladder).toMatchObject({ source: 'repo', path, overrideKeys: [] });
    expect(ladder.raw).toMatchObject({ checks: { build: 'make' } });
  });

  it('describeConfigSources names the repo file', () => {
    const ladder = resolveRunConfigLadder(repoConfig(), {});
    expect(describeConfigSources(ladder, '.factory/constitution.md')).toBe(
      'config: .factory/config.yaml; constitution: .factory/constitution.md',
    );
  });

  it('returns packaged defaults with no raw when nothing is set', () => {
    expect(resolveRunConfigLadder(join(tmp.makeSync('ladder-none-'), 'config.yaml'), {})).toEqual({
      raw: undefined,
      source: 'packaged defaults',
      overrideKeys: [],
    });
  });

  it('FACTORY_CONFIG_YAML replaces the repo config wholesale', () => {
    const ladder = resolveRunConfigLadder(repoConfig(), { FACTORY_CONFIG_YAML: 'version: 2\ndisk:\n  minFreeGb: 3\n' });
    expect(ladder.source).toBe('FACTORY_CONFIG_YAML');
    expect(ladder.raw).toEqual({ version: 2, disk: { minFreeGb: 3 } });
    expect(ladder.raw).not.toHaveProperty('checks');
  });

  it('--config beats FACTORY_CONFIG_PATH beats FACTORY_CONFIG_YAML', () => {
    const path = file('config.yaml', 'version: 2\ndisk:\n  minFreeGb: 7\n');
    const yaml = 'version: 2\ndisk:\n  minFreeGb: 3\n';
    const viaFlag = resolveRunConfigLadder(repoConfig(), {
      FACTORY_CONFIG_PATH: path,
      FACTORY_CONFIG_PATH_SOURCE: '--config',
      FACTORY_CONFIG_YAML: yaml,
    });
    expect(viaFlag).toMatchObject({ source: '--config', path });
    const viaEnv = resolveRunConfigLadder(repoConfig(), { FACTORY_CONFIG_PATH: path, FACTORY_CONFIG_YAML: yaml });
    expect(viaEnv.source).toBe('FACTORY_CONFIG_PATH');
    expect(viaEnv.raw).toMatchObject({ disk: { minFreeGb: 7 } });
    expect(describeConfigSources(viaEnv, 'x')).toContain(`FACTORY_CONFIG_PATH (${path})`);
  });

  it('names the source when the file is missing', () => {
    expect(() =>
      resolveRunConfigLadder('/unused', {
        FACTORY_CONFIG_PATH: '/nope/c.yaml',
        FACTORY_CONFIG_PATH_SOURCE: '--config',
      }),
    ).toThrow('--config: no config file at /nope/c.yaml');
  });

  it('deep-merges FACTORY_CONFIG_OVERRIDES over the winning config', () => {
    const ladder = resolveRunConfigLadder(repoConfig(), { FACTORY_CONFIG_OVERRIDES: 'disk:\n  minFreeGb: 2\n' });
    expect(ladder.raw).toMatchObject({
      version: 2,
      checks: { build: 'make' },
      disk: { minFreeGb: 2, minFreeRatio: 0.1 },
    });
  });

  it('reports the dotted keys the overrides fragment changed', () => {
    const ladder = resolveRunConfigLadder(repoConfig(), {
      FACTORY_CONFIG_OVERRIDES: 'disk:\n  minFreeGb: 2\nsandbox:\n  runtime: none\n',
    });
    expect(ladder.overrideKeys).toEqual(['disk.minFreeGb', 'sandbox.runtime']);
    expect(describeConfigSources(ladder, 'c')).toContain('overrides changed: disk.minFreeGb, sandbox.runtime');
  });

  it('applies an overrides fragment alone, with no file', () => {
    const ladder = resolveRunConfigLadder(join(tmp.makeSync('ladder-frag-'), 'c.yaml'), {
      FACTORY_CONFIG_OVERRIDES: 'disk:\n  minFreeGb: 2\n',
    });
    expect(ladder).toMatchObject({ source: 'packaged defaults', raw: { disk: { minFreeGb: 2 } } });
    // Packaged defaults are v2: the snapshot says so, or loaders read it as a legacy v1 file (#4018).
    expect(ladder.raw).toEqual({ version: 2, disk: { minFreeGb: 2 } });
  });

  it('rejects an unknown key in FACTORY_CONFIG_OVERRIDES naming the source', () => {
    expect(() => resolveRunConfigLadder(repoConfig(), { FACTORY_CONFIG_OVERRIDES: 'bogusTopLevel: 1\n' })).toThrow(
      /^Invalid FACTORY_CONFIG_OVERRIDES: /,
    );
  });

  it('rejects malformed FACTORY_CONFIG_OVERRIDES YAML naming the source', () => {
    expect(() => resolveRunConfigLadder(repoConfig(), { FACTORY_CONFIG_OVERRIDES: 'a: [unclosed\n' })).toThrow(
      /Failed to parse FACTORY_CONFIG_OVERRIDES \(line \d+\)/,
    );
    expect(() => resolveRunConfigLadder(repoConfig(), { FACTORY_CONFIG_OVERRIDES: '- a\n' })).toThrow(
      'Invalid FACTORY_CONFIG_OVERRIDES: expected a mapping',
    );
  });

  it('rejects a non-mapping winner and an invalid inline config naming the label', () => {
    expect(() => resolveRunConfigLadder('/unused', { FACTORY_CONFIG_YAML: '- a\n' })).toThrow(
      'Invalid FACTORY_CONFIG_YAML: expected a mapping',
    );
    expect(() => resolveRunConfigLadder('/unused', { FACTORY_CONFIG_YAML: 'bogusTopLevel: 1\n' })).toThrow(
      /^Invalid FACTORY_CONFIG_YAML: /,
    );
  });

  it('treats a blank FACTORY_CONFIG_OVERRIDES as unset', () => {
    const ladder = resolveRunConfigLadder(repoConfig(), { FACTORY_CONFIG_OVERRIDES: '  \n' });
    expect(ladder.overrideKeys).toEqual([]);
    expect(ladder.source).toBe('repo');
  });

  it('redacts Env-suffixed and secret key names in changed keys', () => {
    const ladder = resolveRunConfigLadder(repoConfig(), {
      FACTORY_CONFIG_OVERRIDES:
        'disk:\n  minFreeGb: 2\npreview:\n  source:\n    kind: deployment\n    environment: SECRET_VALUE\n  command: [x]\n  urlEnv: SECRET_URL\n',
    });
    expect(ladder.overrideKeys).toContain('disk.minFreeGb');
    expect(ladder.overrideKeys).toContain('<redacted key>');
    expect(ladder.overrideKeys).toContain('preview.source.environment');
    expect(JSON.stringify(ladder.overrideKeys)).not.toMatch(/urlEnv|SECRET_URL/);
  });
});

describe('resolveConstitutionOverride (#3906)', () => {
  it('FACTORY_CONSTITUTION_PATH beats inline FACTORY_CONSTITUTION', () => {
    const path = file('c.md', 'From file.\n');
    expect(
      resolveConstitutionOverride({ FACTORY_CONSTITUTION_PATH: path, FACTORY_CONSTITUTION: 'Inline.' }),
    ).toMatchObject({ source: 'FACTORY_CONSTITUTION_PATH', path, text: 'From file.\n' });
    expect(
      resolveConstitutionOverride({
        FACTORY_CONSTITUTION_PATH: path,
        FACTORY_CONSTITUTION_PATH_SOURCE: '--constitution',
      })?.source,
    ).toBe('--constitution');
  });

  it('uses the inline text, or undefined when nothing is set', () => {
    expect(resolveConstitutionOverride({ FACTORY_CONSTITUTION: 'Inline.' })).toEqual({
      text: 'Inline.',
      source: 'FACTORY_CONSTITUTION',
    });
    expect(resolveConstitutionOverride({ FACTORY_CONSTITUTION: ' ' })).toBeUndefined();
  });

  it('throws naming the label for a missing or empty file', () => {
    expect(() => resolveConstitutionOverride({ FACTORY_CONSTITUTION_PATH: '/nope/c.md' })).toThrow(
      'FACTORY_CONSTITUTION_PATH: no constitution file',
    );
    expect(() => resolveConstitutionOverride({ FACTORY_CONSTITUTION_PATH: file('e.md', ' \n') })).toThrow(
      'FACTORY_CONSTITUTION_PATH: constitution file is empty',
    );
  });
});
