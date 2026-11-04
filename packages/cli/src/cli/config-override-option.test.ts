import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { applyConfigOverrideOptions, constitutionSourceLabel } from './config-override-option.js';
import { h, installShipHarness, runMainWith } from './test-support/ship-harness.js';

installShipHarness();
const tmp = createTempDirs();
afterEach(async () => {
  vi.unstubAllEnvs();
  delete process.env.FACTORY_CONFIG_PATH;
  delete process.env.FACTORY_CONFIG_PATH_SOURCE;
  delete process.env.FACTORY_CONSTITUTION_PATH;
  delete process.env.FACTORY_CONSTITUTION_PATH_SOURCE;
  await tmp.cleanup();
});

describe('applyConfigOverrideOptions (#3906)', () => {
  it('writes --config and --constitution as absolute env paths inherited by every command', async () => {
    const cwd = tmp.makeSync('override-cwd-');
    writeFileSync(join(cwd, 'c.yaml'), 'version: 2\n');
    writeFileSync(join(cwd, 'k.md'), 'standards\n');
    const env: NodeJS.ProcessEnv = {};
    applyConfigOverrideOptions({ config: 'c.yaml', constitution: 'k.md' }, cwd, env);
    expect(env).toEqual({
      FACTORY_CONFIG_PATH: join(cwd, 'c.yaml'),
      FACTORY_CONFIG_PATH_SOURCE: '--config',
      FACTORY_CONSTITUTION_PATH: join(cwd, 'k.md'),
      FACTORY_CONSTITUTION_PATH_SOURCE: '--constitution',
    });

    // The global flags reach process.env before any command (ship, run-issue, run, ...) executes.
    const real = join(h.repoRoot, 'real.yaml');
    writeFileSync(real, 'version: 2\n');
    const res = await runMainWith(undefined, '--config', real, 'ship', '5', '--no-pr');
    expect(res.exited).toBe(false);
    expect(process.env.FACTORY_CONFIG_PATH).toBe(real);
    expect(process.env.FACTORY_CONFIG_PATH_SOURCE).toBe('--config');
  });

  it('sets nothing when no flag is given', () => {
    const env: NodeJS.ProcessEnv = {};
    applyConfigOverrideOptions({}, '/nowhere', env);
    expect(env).toEqual({});
  });

  it('a missing --config file throws', () => {
    expect(() => applyConfigOverrideOptions({ config: 'nope.yaml' }, '/nowhere', {})).toThrow('--config: no such file');
  });

  it('a missing --config file exits 2 from the program', async () => {
    const res = await runMainWith(undefined, '--config', '/nope/missing.yaml', 'ship', '5');
    expect(res).toEqual({ exited: true, code: 2 });
  });
});

describe('constitutionSourceLabel', () => {
  it('names the committed instance, the override, or the fallback', () => {
    const root = tmp.makeSync('label-root-');
    expect(constitutionSourceLabel(root)).toBe('repo instruction files / bundled');
    mkdirSync(join(root, '.factory'));
    writeFileSync(join(root, '.factory', 'constitution.md'), 'x');
    expect(constitutionSourceLabel(root)).toBe('.factory/constitution.md');
    vi.stubEnv('FACTORY_CONSTITUTION', 'inline');
    expect(constitutionSourceLabel(root)).toBe('FACTORY_CONSTITUTION');
  });
});
