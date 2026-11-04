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

  it('turns a ladder error into a failing row instead of throwing', () => {
    vi.stubEnv('FACTORY_CONFIG_OVERRIDES', 'bogusTopLevel: 1\n');
    const held = holdDoctorConfigSources('/repo', '/repo/.factory/config.yaml');
    expect(held.check).toMatchObject({ name: 'config sources', ok: false });
    expect(held.check.detail).toContain('Invalid FACTORY_CONFIG_OVERRIDES');
    expect(held.sources).toBeNull();
    held.release();
  });
});
