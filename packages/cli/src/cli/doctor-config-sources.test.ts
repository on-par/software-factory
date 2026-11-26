import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { configSourcesCheck, holdDoctorConfigSources } from './doctor-config-sources.js';
import { coreFakes, h, installDoctorHarness, logged, runMainWith } from './test-support/doctor-harness.js';

installDoctorHarness();
afterEach(() => vi.unstubAllEnvs());

describe('doctor config sources (#3906)', () => {
  it('builds an ok row describing the sources', () => {
    const row = configSourcesCheck(
      { raw: {}, source: 'FACTORY_CONFIG_YAML', overrideKeys: ['a.b'] },
      'FACTORY_CONSTITUTION',
    );
    expect(row).toMatchObject({ name: 'config sources', ok: true });
    expect(row.detail).toBe('config: FACTORY_CONFIG_YAML; constitution: FACTORY_CONSTITUTION; overrides changed: a.b');
  });

  it('reports config and constitution sources in the json sources field', async () => {
    h.execSyncImpl = (cmd: string) => (cmd.includes('rev-parse') ? h.repoRoot : '');
    coreFakes.isCommandAvailable.mockImplementation(() => false);
    vi.stubEnv('FACTORY_CONFIG_OVERRIDES', 'disk:\n  minFreeGb: 2\n');
    vi.stubEnv('FACTORY_CONSTITUTION', 'Inline.');
    await runMainWith(undefined, 'doctor', '--json');
    const out = JSON.parse(logged().slice(logged().indexOf('{'))) as {
      sources: { config: { source: string; overrideKeys: string[] }; constitution: { source: string } };
      checks: { name: string; detail: string }[];
    };
    expect(out.sources).toEqual({
      config: { source: 'packaged defaults', overrideKeys: ['disk.minFreeGb'] },
      constitution: { source: 'FACTORY_CONSTITUTION' },
    });
    expect(out.checks.find((c) => c.name === 'config sources')?.detail).toContain('disk.minFreeGb');
  });

  it.each([
    { name: '--project-config', viaFlag: true, source: '--project-config' },
    { name: 'FACTORY_PROJECT_CONFIG_DIR', viaFlag: false, source: 'FACTORY_PROJECT_CONFIG_DIR' },
  ])('shows external source ($name) (#4340)', async ({ viaFlag, source }) => {
    h.execSyncImpl = (cmd: string) => (cmd.includes('rev-parse') ? h.repoRoot : '');
    coreFakes.isCommandAvailable.mockImplementation(() => false);
    const dir = mkdtempSync(join(h.repoRoot, 'external-'));
    writeFileSync(join(dir, 'config.yaml'), 'version: 2\n');
    writeFileSync(join(dir, 'constitution.md'), 'External standards');
    mkdirSync(join(h.repoRoot, '.factory', 'tests'), { recursive: true });
    writeFileSync(join(h.repoRoot, '.factory', 'constitution.md'), 'Checkout standards');
    vi.stubEnv('FACTORY_PROJECT_CONFIG_DIR', viaFlag ? '' : dir);
    vi.stubEnv('FACTORY_PROJECT_CONFIG_DIR_SOURCE', '');
    const flag = viaFlag ? ['--project-config', dir] : [];

    await runMainWith(undefined, ...flag, 'doctor', '--json');

    const out = JSON.parse(logged().slice(logged().indexOf('{'))) as {
      sources: { constitution: { source: string }; projectConfig?: unknown };
      checks: { name: string; detail: string }[];
    };
    const ignoredInputs = ['.factory/constitution.md', '.factory/tests'];
    expect(out.sources.projectConfig).toEqual({ source, dir, ignoredInputs });
    expect(out.sources.constitution).toEqual({ source });
    expect(out.checks.find((c) => c.name === 'config sources')?.detail).toBe(
      `config: ${source} (${join(dir, 'config.yaml')}); constitution: ${source}; external source: ${source} (${dir}); ignored checkout inputs: ${ignoredInputs.join(', ')}`,
    );
    expect(logged()).not.toContain('Checkout standards');
  });

  it('turns a ladder error into a failing row instead of throwing', () => {
    vi.stubEnv('FACTORY_CONFIG_OVERRIDES', 'bogusTopLevel: 1\n');
    const held = holdDoctorConfigSources('/repo', '/repo/.factory/config.yaml');
    expect(held.check).toMatchObject({ name: 'config sources', ok: false });
    expect(held.check.detail).toContain('Invalid FACTORY_CONFIG_OVERRIDES');
    expect(held.sources).toBeNull();
    held.release();
  });
});
