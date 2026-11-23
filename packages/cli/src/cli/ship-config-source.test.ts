// shipIssue reports the config and constitution sources and fails a bad override before PLAN (#3906).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createTempDirs } from '@on-par/factory-core/testing';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { h, installShipHarness, logged, paths, phases, shipIssue } from './test-support/ship-harness.js';

installShipHarness();
const tmp = createTempDirs();
afterEach(async () => {
  vi.unstubAllEnvs();
  await tmp.cleanup();
});

describe('shipIssue config sources (#3906)', () => {
  it('shipIssue logs the config source line', async () => {
    vi.stubEnv('FACTORY_CONFIG_OVERRIDES', 'disk:\n  minFreeGb: 2\n');
    vi.stubEnv('FACTORY_CONSTITUTION', 'Inline standards.');

    await shipIssue(5, {});

    expect(logged()).toContain(
      'factory: config: packaged defaults; constitution: FACTORY_CONSTITUTION; overrides changed: disk.minFreeGb',
    );
    const events = existsSync(paths().events) ? readFileSync(paths().events, 'utf-8') : '';
    expect(events).toContain('"config_source"');
    expect(events).toContain('disk.minFreeGb');
    expect(phases.planPhase).toHaveBeenCalled();
    expect(existsSync(join(h.repoRoot, '.factory', 'config.yaml'))).toBe(false);
  });

  it('a bad override throws before PLAN naming FACTORY_CONFIG_OVERRIDES', async () => {
    vi.stubEnv('FACTORY_CONFIG_OVERRIDES', 'bogusTopLevel: 1\n');

    await expect(shipIssue(5, {})).rejects.toThrow(/Invalid FACTORY_CONFIG_OVERRIDES/);

    expect(phases.planPhase).not.toHaveBeenCalled();
    expect(process.env.FACTORY_RUN_CONFIG_JSON).toBeUndefined();
  });

  it('invalid external config.yaml names source and file', async () => {
    const dir = tmp.makeSync('ship-project-');
    writeFileSync(join(dir, 'config.yaml'), 'version: 2\nbogusTopLevel: 1\n');
    vi.stubEnv('FACTORY_PROJECT_CONFIG_DIR', dir);

    await expect(shipIssue(5, {})).rejects.toThrow(
      new RegExp(`FACTORY_PROJECT_CONFIG_DIR.*${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*config\\.yaml`),
    );

    expect(process.env.FACTORY_RUN_CONFIG_JSON).toBeUndefined();
  });
});
