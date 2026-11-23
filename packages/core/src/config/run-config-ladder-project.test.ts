import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConstitutionLoader } from '../constitutions/index.js';
import { createTempDirs } from '../harness/temp-dir.js';
import { resolveRunConfigLadder } from './run-config-ladder.js';

const tmp = createTempDirs();
afterEach(async () => {
  vi.unstubAllEnvs();
  await tmp.cleanup();
});

const cfg = (gb: number): string => `version: 2\ndisk:\n  minFreeGb: ${gb}\n`;
const constitution = (name: string): string => `# ${name}\n\nStandards from ${name}.\n`;

function repo(withFiles: boolean): { root: string; configPath: string } {
  const root = tmp.makeSync('project-repo-');
  const configPath = join(root, '.factory', 'config.yaml');
  if (withFiles) {
    mkdirSync(join(root, '.factory'));
    writeFileSync(configPath, cfg(10));
    writeFileSync(join(root, '.factory', 'constitution.md'), constitution('repo'));
  }
  return { root, configPath };
}

function external(config: string | undefined, text: string | undefined): string {
  const dir = tmp.makeSync('project-ext-');
  if (config !== undefined) writeFileSync(join(dir, 'config.yaml'), config);
  if (text !== undefined) writeFileSync(join(dir, 'constitution.md'), text);
  return dir;
}

function file(name: string, text: string): string {
  const path = join(tmp.makeSync('project-file-'), name);
  writeFileSync(path, text);
  return path;
}

function stubEnv(env: Record<string, string>): void {
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
}

describe('project config dir at rank 3 (#4338)', () => {
  it('external source replaces repo file at rank 3', () => {
    const { root, configPath } = repo(true);
    const dir = external(cfg(3), constitution('external'));
    const env = { FACTORY_PROJECT_CONFIG_DIR: dir };
    const ladder = resolveRunConfigLadder(configPath, env);
    expect(ladder).toMatchObject({ source: 'FACTORY_PROJECT_CONFIG_DIR', path: join(dir, 'config.yaml') });
    expect(ladder.raw).toEqual({ version: 2, disk: { minFreeGb: 3 } });
    stubEnv(env);
    const loaded = new ConstitutionLoader().loadRepoConstitution(root);
    expect(loaded?.repoInstance?.absPath).toBe(join(dir, 'constitution.md'));
    expect(loaded?.body).toContain('Standards from external');
  });

  const configCases = [
    { name: 'none', extra: {}, source: 'FACTORY_PROJECT_CONFIG_DIR', gb: 3 },
    { name: 'FACTORY_CONFIG_PATH', extra: { path: true }, source: 'FACTORY_CONFIG_PATH', gb: 7 },
    { name: 'FACTORY_CONFIG_YAML', extra: { yaml: true }, source: 'FACTORY_CONFIG_YAML', gb: 5 },
  ];
  const combos = configCases.flatMap((c) =>
    [true, false].flatMap((overrides) => [true, false].map((withRepo) => ({ ...c, overrides, withRepo }))),
  );

  it.each(combos)('ladder matrix: config $name overrides=$overrides repo=$withRepo', (c) => {
    const { configPath } = repo(c.withRepo);
    const env: Record<string, string> = { FACTORY_PROJECT_CONFIG_DIR: external(cfg(3), undefined) };
    if (c.extra.path) env.FACTORY_CONFIG_PATH = file('config.yaml', cfg(7));
    if (c.extra.yaml) env.FACTORY_CONFIG_YAML = cfg(5);
    if (c.overrides) env.FACTORY_CONFIG_OVERRIDES = 'disk:\n  minRatio: 0.5\n  minFreeRatio: 0.2\n';
    const ladder = resolveRunConfigLadder(configPath, env);
    expect(ladder.source).toBe(c.source);
    expect(ladder.raw).toMatchObject({ disk: { minFreeGb: c.gb, ...(c.overrides ? { minFreeRatio: 0.2 } : {}) } });
  });

  it('ladder matrix: unset external keeps the repo file', () => {
    const { configPath } = repo(true);
    expect(resolveRunConfigLadder(configPath, {}).source).toBe('repo');
    expect(resolveRunConfigLadder(configPath, { FACTORY_PROJECT_CONFIG_DIR: '  ' }).source).toBe('repo');
  });

  const constitutionCases = [
    { name: 'none', env: () => ({}), expected: 'external' },
    {
      name: '--constitution',
      env: () => ({ FACTORY_CONSTITUTION_PATH: file('k.md', constitution('path')) }),
      expected: 'path',
    },
    { name: 'FACTORY_CONSTITUTION', env: () => ({ FACTORY_CONSTITUTION: constitution('inline') }), expected: 'inline' },
  ];
  const constitutionCombos = constitutionCases.flatMap((c) =>
    [true, false].flatMap((withRepo) => [true, false].map((withExternal) => ({ ...c, withRepo, withExternal }))),
  );

  it.each(constitutionCombos)('ladder matrix: constitution $name repo=$withRepo external=$withExternal', (c) => {
    const { root } = repo(c.withRepo);
    const env: Record<string, string> = { ...c.env() };
    if (c.withExternal) env.FACTORY_PROJECT_CONFIG_DIR = external(undefined, constitution('external'));
    stubEnv(env);
    const body = new ConstitutionLoader().loadRepoConstitution(root)?.body;
    if (c.name !== 'none') expect(body).toContain(`Standards from ${c.expected}`);
    else if (c.withExternal) expect(body).toContain('Standards from external');
    else if (c.withRepo) expect(body).toContain('Standards from repo');
    else expect(body).toBeUndefined();
  });

  it('a missing dir throws naming the source', () => {
    expect(() => resolveRunConfigLadder('/x/config.yaml', { FACTORY_PROJECT_CONFIG_DIR: '/no/such/dir' })).toThrow(
      'FACTORY_PROJECT_CONFIG_DIR: no such directory: /no/such/dir',
    );
  });

  it('a dir without config.yaml gives packaged defaults even with a repo file', () => {
    const { configPath } = repo(true);
    const ladder = resolveRunConfigLadder(configPath, { FACTORY_PROJECT_CONFIG_DIR: external(undefined, undefined) });
    expect(ladder).toEqual({ raw: undefined, source: 'packaged defaults', overrideKeys: [] });
  });

  it('a dir without constitution.md hides the repo constitution', () => {
    const { root } = repo(true);
    stubEnv({ FACTORY_PROJECT_CONFIG_DIR: external(cfg(3), undefined) });
    expect(new ConstitutionLoader().loadRepoConstitution(root)).toBeNull();
  });

  it('an unknown key or a non-mapping names the dir and config.yaml', () => {
    const { configPath } = repo(true);
    const bad = external('version: 2\nbogusTopLevel: 1\n', undefined);
    expect(() => resolveRunConfigLadder(configPath, { FACTORY_PROJECT_CONFIG_DIR: bad })).toThrow(
      `Invalid FACTORY_PROJECT_CONFIG_DIR (${join(bad, 'config.yaml')})`,
    );
    const list = external('- a\n- b\n', undefined);
    expect(() => resolveRunConfigLadder(configPath, { FACTORY_PROJECT_CONFIG_DIR: list })).toThrow(
      join(list, 'config.yaml'),
    );
  });

  it('labels the source --project-config when the flag set it', () => {
    const { configPath } = repo(false);
    const env = {
      FACTORY_PROJECT_CONFIG_DIR: external(cfg(3), undefined),
      FACTORY_PROJECT_CONFIG_DIR_SOURCE: '--project-config',
    };
    expect(resolveRunConfigLadder(configPath, env).source).toBe('--project-config');
  });
});
