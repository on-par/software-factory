// shipIssue reports the config and constitution sources and fails a bad override before PLAN (#3906).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

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
    const dir = tmp.makeSync('ship-project-config-');
    writeFileSync(join(dir, 'config.yaml'), 'bogusTopLevel: 1\n');
    vi.stubEnv('FACTORY_PROJECT_CONFIG_DIR', dir);

    await expect(shipIssue(5, {})).rejects.toThrow(join(dir, 'config.yaml'));
  });

  it.each([
    { file: 'agent-memory/notes.txt', reason: 'not a .md lane memory file' },
    { file: 'product', reason: "invalid product name '_x'" },
  ])('invalid external $file names source and file before PLAN (#4339)', async ({ file, reason }) => {
    const dir = tmp.makeSync('ship-project-inputs-');
    writeFileSync(join(dir, 'config.yaml'), 'version: 2\n');
    mkdirSync(join(dir, 'agent-memory'));
    writeFileSync(join(dir, file), '_x');
    vi.stubEnv('FACTORY_PROJECT_CONFIG_DIR', dir);

    const expected = `Invalid FACTORY_PROJECT_CONFIG_DIR (${join(dir, file)}): ${reason}`;
    await expect(shipIssue(5, {})).rejects.toThrow(expected);
    expect(process.env.FACTORY_RUN_CONFIG_JSON).toBeUndefined();
  });
});

function configSourceEvent(): { msg: string; projectConfig?: unknown } | undefined {
  const lines = existsSync(paths().events) ? readFileSync(paths().events, 'utf-8').split('\n') : [];
  return lines
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string; msg: string; projectConfig?: unknown })
    .find((event) => event.type === 'config_source');
}

function externalDir(): string {
  const dir = tmp.makeSync('ship-external-source-');
  writeFileSync(join(dir, 'config.yaml'), 'version: 2\n');
  writeFileSync(join(dir, 'constitution.md'), 'External standards');
  return dir;
}

describe('shipIssue external source report (#4340)', () => {
  it.each([
    { source: 'FACTORY_PROJECT_CONFIG_DIR', flag: false },
    { source: '--project-config', flag: true },
  ])('names external source ($source)', async ({ source, flag }) => {
    const dir = externalDir();
    vi.stubEnv('FACTORY_PROJECT_CONFIG_DIR', dir);
    if (flag) vi.stubEnv('FACTORY_PROJECT_CONFIG_DIR_SOURCE', '--project-config');

    await shipIssue(5, {});

    expect(logged()).toContain(
      `factory: config: ${source} (${join(dir, 'config.yaml')}); constitution: ${source}; external source: ${source} (${dir})`,
    );
    expect(configSourceEvent()?.msg).toContain(`external source: ${source} (${dir})`);
  });

  it.each([
    { name: 'no .factory files', files: {}, ignored: [] },
    {
      name: 'tracked inputs',
      files: {
        '.factory/config.yaml': 'version: 2\n',
        '.factory/constitution.md': 'Checkout standards',
        '.factory/agent-memory/core.md': 'checkout memory',
        '.factory/tests/test_checkout.py': 'def test_checkout(): pass\n',
      },
      ignored: ['.factory/agent-memory', '.factory/config.yaml', '.factory/constitution.md', '.factory/tests'],
    },
  ])('reports ignored checkout inputs by path ($name)', async ({ files, ignored }) => {
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(dirname(join(h.repoRoot, rel)), { recursive: true });
      writeFileSync(join(h.repoRoot, rel), text);
    }
    const dir = externalDir();
    vi.stubEnv('FACTORY_PROJECT_CONFIG_DIR', dir);

    await shipIssue(5, {});

    const event = configSourceEvent();
    expect(event?.projectConfig).toEqual({ source: 'FACTORY_PROJECT_CONFIG_DIR', dir, ignoredInputs: ignored });
    const suffix = ignored.length > 0 ? `; ignored checkout inputs: ${ignored.join(', ')}` : '';
    expect(event?.msg.endsWith(`external source: FACTORY_PROJECT_CONFIG_DIR (${dir})${suffix}`)).toBe(true);
    expect(logged()).toContain(`(${dir})${suffix}`);
    expect(JSON.stringify(event)).not.toContain('Checkout standards');
  });

  it('leaves the config line and event unchanged when no external source is set', async () => {
    vi.stubEnv('FACTORY_CONSTITUTION', 'Inline standards.');

    await shipIssue(5, {});

    expect(logged().split('\n')).toContain('factory: config: packaged defaults; constitution: FACTORY_CONSTITUTION');
    expect(configSourceEvent()).toMatchObject({ msg: 'config: packaged defaults; constitution: FACTORY_CONSTITUTION' });
    expect(configSourceEvent()).not.toHaveProperty('projectConfig');
  });
});
