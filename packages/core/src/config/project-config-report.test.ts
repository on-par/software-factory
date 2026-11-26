import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import { ignoredCheckoutInputs, projectConfigReport } from './project-config-report.js';
import { describeConfigSources, type RunConfigLadder } from './run-config-ladder.js';

const tmp = createTempDirs();
afterEach(async () => {
  await tmp.cleanup();
});

function checkout(files: string[]): string {
  const root = tmp.makeSync('pcr-checkout-');
  for (const rel of files) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), 'SECRET-CONTENT');
  }
  return root;
}

const ladder: RunConfigLadder = {
  raw: {},
  source: 'FACTORY_PROJECT_CONFIG_DIR',
  path: '/p/config.yaml',
  overrideKeys: [],
};

describe('project config report (#4340)', () => {
  it.each([
    { name: 'no .factory files', files: [], ignored: [] },
    {
      name: 'every input',
      files: [
        '.factory/tests/test_a.py',
        '.factory/state/product',
        '.factory/constitution.md',
        '.factory/config.yml',
        '.factory/config.yaml',
        '.factory/config.json',
        '.factory/agent-memory/core.md',
      ],
      ignored: [
        '.factory/agent-memory',
        '.factory/config.json',
        '.factory/config.yaml',
        '.factory/config.yml',
        '.factory/constitution.md',
        '.factory/tests',
      ],
    },
    {
      name: 'unrelated .factory files',
      files: ['.factory/state/events.ndjson', '.factory/.gitignore'],
      ignored: [],
    },
  ])('lists ignored checkout inputs by path ($name)', ({ files, ignored }) => {
    expect(ignoredCheckoutInputs(checkout(files))).toEqual(ignored);
  });

  it.each([
    { name: 'product', files: ['.factory/state/product'] },
    { name: 'events and logs', files: ['.factory/state/events.ndjson', '.factory/state/logs/run.log'] },
    { name: 'plans and locks', files: ['.factory/state/plans/issue-1.md', '.factory/state/locks/run/issue-1'] },
    { name: 'input lookalikes', files: ['.factory/state/config.yaml', '.factory/state/agent-memory/core.md'] },
  ])('lists no runtime state under .factory/state/ ($name)', ({ files }) => {
    expect(ignoredCheckoutInputs(checkout(files))).toEqual([]);
  });

  it.each([
    { name: 'unset', env: {}, expected: () => undefined },
    { name: 'blank', env: { FACTORY_PROJECT_CONFIG_DIR: ' ' }, expected: () => undefined },
    {
      name: 'env',
      env: { FACTORY_PROJECT_CONFIG_DIR: 'DIR' },
      expected: (dir: string) => ({
        source: 'FACTORY_PROJECT_CONFIG_DIR',
        dir,
        ignoredInputs: ['.factory/constitution.md'],
      }),
    },
    {
      name: 'flag',
      env: { FACTORY_PROJECT_CONFIG_DIR: 'DIR', FACTORY_PROJECT_CONFIG_DIR_SOURCE: '--project-config' },
      expected: (dir: string) => ({ source: '--project-config', dir, ignoredInputs: ['.factory/constitution.md'] }),
    },
  ])('reports the external source ($name)', ({ env, expected }) => {
    const root = checkout(['.factory/constitution.md']);
    const dir = tmp.makeSync('pcr-external-');
    const resolved = Object.fromEntries(Object.entries(env).map(([k, v]) => [k, v === 'DIR' ? dir : v]));
    expect(projectConfigReport(root, resolved)).toEqual(expected(dir));
  });

  it.each([
    {
      name: 'unset',
      project: undefined,
      line: 'config: FACTORY_PROJECT_CONFIG_DIR (/p/config.yaml); constitution: FACTORY_PROJECT_CONFIG_DIR',
    },
    {
      name: 'no ignored inputs',
      project: { source: '--project-config', dir: '/p', ignoredInputs: [] },
      line: 'config: FACTORY_PROJECT_CONFIG_DIR (/p/config.yaml); constitution: FACTORY_PROJECT_CONFIG_DIR; external source: --project-config (/p)',
    },
    {
      name: 'ignored inputs',
      project: { source: '--project-config', dir: '/p', ignoredInputs: ['.factory/config.yaml', '.factory/tests'] },
      line: 'config: FACTORY_PROJECT_CONFIG_DIR (/p/config.yaml); constitution: FACTORY_PROJECT_CONFIG_DIR; external source: --project-config (/p); ignored checkout inputs: .factory/config.yaml, .factory/tests',
    },
  ])('describes the external source in the config line ($name)', ({ project, line }) => {
    expect(describeConfigSources(ladder, 'FACTORY_PROJECT_CONFIG_DIR', project)).toBe(line);
  });
});
