import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConstitutionLoader } from '../constitutions/index.js';
import { createTempDirs } from '../harness/temp-dir.js';
import { resolveProjectConfigDir, resolveRunConfigLadder } from './run-config-ladder.js';

const tmp = createTempDirs();
afterEach(async () => {
  vi.unstubAllEnvs();
  await tmp.cleanup();
});

const yaml = (n: number): string => `version: 2\ndisk:\n  minFreeGb: ${n}\n`;

function repo(withConfig: boolean, withConstitution: boolean): { dir: string; configPath: string } {
  const dir = tmp.makeSync('pcl-repo-');
  mkdirSync(join(dir, '.factory'));
  if (withConfig) writeFileSync(join(dir, '.factory', 'config.yaml'), yaml(10));
  if (withConstitution) writeFileSync(join(dir, '.factory', 'constitution.md'), 'Repo standards');
  return { dir, configPath: join(dir, '.factory', 'config.yaml') };
}

function projectDir(
  files: Record<string, string> = { 'config.yaml': yaml(3), 'constitution.md': 'Project standards' },
) {
  const dir = tmp.makeSync('pcl-project-');
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

function file(name: string, text: string): string {
  const path = join(tmp.makeSync('pcl-file-'), name);
  writeFileSync(path, text);
  return path;
}

describe('project config directory (#4338)', () => {
  it('external source replaces repo file at rank 3', () => {
    const r = repo(true, true);
    const dir = projectDir();
    vi.stubEnv('FACTORY_PROJECT_CONFIG_DIR', dir);
    const ladder = resolveRunConfigLadder(r.configPath, process.env);
    expect(ladder.source).toBe('FACTORY_PROJECT_CONFIG_DIR');
    expect(ladder.path).toBe(join(dir, 'config.yaml'));
    expect((ladder.raw?.disk as { minFreeGb: number } | undefined)?.minFreeGb).toBe(3);
    const loaded = new ConstitutionLoader().loadRepoConstitution(r.dir);
    expect(loaded?.body).toContain('Project standards');
    expect(loaded?.repoInstance?.absPath).toBe(join(dir, 'constitution.md'));
  });

  it('ladder matrix', () => {
    const configCases = [
      { name: 'none', env: {}, source: undefined, value: undefined },
      {
        name: '--config',
        env: { FACTORY_CONFIG_PATH: 'FILE', FACTORY_CONFIG_PATH_SOURCE: '--config' },
        source: '--config',
        value: 4,
      },
      { name: 'FACTORY_CONFIG_PATH', env: { FACTORY_CONFIG_PATH: 'FILE' }, source: 'FACTORY_CONFIG_PATH', value: 4 },
      { name: 'FACTORY_CONFIG_YAML', env: { FACTORY_CONFIG_YAML: yaml(5) }, source: 'FACTORY_CONFIG_YAML', value: 5 },
    ];
    for (const project of [false, true]) {
      for (const c of configCases) {
        for (const overrides of [false, true]) {
          for (const repoPresent of [false, true]) {
            const r = repo(repoPresent, false);
            const env: NodeJS.ProcessEnv = { ...c.env };
            if (env.FACTORY_CONFIG_PATH === 'FILE') env.FACTORY_CONFIG_PATH = file('c.yaml', yaml(4));
            if (project) env.FACTORY_PROJECT_CONFIG_DIR = projectDir();
            if (overrides) env.FACTORY_CONFIG_OVERRIDES = 'disk:\n  minFreeGb: 7\n';
            const label = `${project}/${c.name}/${overrides}/${repoPresent}`;
            const ladder = resolveRunConfigLadder(r.configPath, env);
            const expectedSource =
              c.source ?? (project ? 'FACTORY_PROJECT_CONFIG_DIR' : repoPresent ? 'repo' : 'packaged defaults');
            const base = c.value ?? (project ? 3 : repoPresent ? 10 : undefined);
            const expected = overrides ? 7 : base;
            expect(ladder.source, label).toBe(expectedSource);
            expect((ladder.raw?.disk as { minFreeGb: number } | undefined)?.minFreeGb, label).toBe(expected);
          }
        }
      }
    }

    const constitutionCases = [
      { name: 'none', env: {}, body: undefined },
      {
        name: '--constitution',
        env: { FACTORY_CONSTITUTION_PATH: 'FILE', FACTORY_CONSTITUTION_PATH_SOURCE: '--constitution' },
        body: 'Flag standards',
      },
      { name: 'FACTORY_CONSTITUTION_PATH', env: { FACTORY_CONSTITUTION_PATH: 'FILE' }, body: 'Flag standards' },
      { name: 'FACTORY_CONSTITUTION', env: { FACTORY_CONSTITUTION: 'Inline standards' }, body: 'Inline standards' },
    ];
    for (const project of [false, true]) {
      for (const c of constitutionCases) {
        for (const repoPresent of [false, true]) {
          const r = repo(false, repoPresent);
          for (const [k, v] of Object.entries(c.env)) {
            vi.stubEnv(k, v === 'FILE' ? file('k.md', 'Flag standards') : v);
          }
          if (project) vi.stubEnv('FACTORY_PROJECT_CONFIG_DIR', projectDir());
          const loaded = new ConstitutionLoader().loadRepoConstitution(r.dir);
          const expected = c.body ?? (project ? 'Project standards' : repoPresent ? 'Repo standards' : undefined);
          const label = `${project}/${c.name}/${repoPresent}`;
          if (expected === undefined) expect(loaded, label).toBeNull();
          else expect(loaded?.body, label).toContain(expected);
          vi.unstubAllEnvs();
        }
      }
    }
  });

  it('ignores a blank or whitespace env var', () => {
    expect(resolveProjectConfigDir({ FACTORY_PROJECT_CONFIG_DIR: '' })).toBeUndefined();
    expect(resolveProjectConfigDir({ FACTORY_PROJECT_CONFIG_DIR: '   ' })).toBeUndefined();
  });

  it('labels the flag source', () => {
    const dir = projectDir();
    expect(
      resolveProjectConfigDir({
        FACTORY_PROJECT_CONFIG_DIR: dir,
        FACTORY_PROJECT_CONFIG_DIR_SOURCE: '--project-config',
      }),
    ).toEqual({ dir, source: '--project-config' });
  });

  it('a missing directory or a regular file throws naming the source and path', () => {
    const missing = join(tmp.makeSync('pcl-gone-'), 'nope');
    expect(() => resolveRunConfigLadder('/x', { FACTORY_PROJECT_CONFIG_DIR: missing })).toThrow(
      `FACTORY_PROJECT_CONFIG_DIR: no such directory: ${missing}`,
    );
    const regular = file('f.txt', 'x');
    expect(() => resolveProjectConfigDir({ FACTORY_PROJECT_CONFIG_DIR: regular })).toThrow('no such directory');
  });

  it('a directory without config.yaml throws naming the directory', () => {
    const dir = projectDir({ 'constitution.md': 'x' });
    expect(() => resolveRunConfigLadder('/x', { FACTORY_PROJECT_CONFIG_DIR: dir })).toThrow(`no config.yaml in ${dir}`);
  });

  it('a missing or empty constitution.md throws naming constitution.md', () => {
    const missing = projectDir({ 'config.yaml': yaml(3) });
    vi.stubEnv('FACTORY_PROJECT_CONFIG_DIR', missing);
    expect(() => new ConstitutionLoader().loadRepoConstitution('/x')).toThrow('no constitution.md in');
    const empty = projectDir({ 'config.yaml': yaml(3), 'constitution.md': '  \n' });
    vi.stubEnv('FACTORY_PROJECT_CONFIG_DIR', empty);
    expect(() => new ConstitutionLoader().loadRepoConstitution('/x')).toThrow('constitution file is empty');
  });

  it('a non-mapping or invalid config.yaml names the source and file', () => {
    const list = projectDir({ 'config.yaml': '- a\n' });
    expect(() => resolveRunConfigLadder('/x', { FACTORY_PROJECT_CONFIG_DIR: list })).toThrow(
      `Invalid FACTORY_PROJECT_CONFIG_DIR (${join(list, 'config.yaml')}): expected a mapping`,
    );
    const bogus = projectDir({ 'config.yaml': 'version: 2\nbogusTopLevel: 1\n' });
    expect(() => resolveRunConfigLadder('/x', { FACTORY_PROJECT_CONFIG_DIR: bogus })).toThrow(
      `Invalid FACTORY_PROJECT_CONFIG_DIR (${join(bogus, 'config.yaml')})`,
    );
  });
});
