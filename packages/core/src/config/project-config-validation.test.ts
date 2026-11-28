import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import { validateProjectInputs } from './project-input-validation.js';

const tmp = createTempDirs();
afterEach(async () => {
  await tmp.cleanup();
});

function projectDir(files: Record<string, string | Buffer>, link?: { at: string; to: string }): string {
  const root = tmp.makeSync('pcv-project-');
  writeFileSync(join(root, 'config.yaml'), 'version: 2\n');
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  if (link) {
    mkdirSync(dirname(join(root, link.at)), { recursive: true });
    symlinkSync(join(root, link.to), join(root, link.at));
  }
  return root;
}

interface InvalidCase {
  file: string;
  files: Record<string, string | Buffer>;
  link?: { at: string; to: string };
  reason: string;
}

describe('project config directory input validation (#4339)', () => {
  it.each<InvalidCase>([
    { file: 'agent-memory/core.md', files: { 'agent-memory/core.md': 'x'.repeat(4097) }, reason: 'over the 4096' },
    { file: 'agent-memory/notes.txt', files: { 'agent-memory/notes.txt': 'x' }, reason: 'not a .md lane memory file' },
    { file: 'agent-memory/bin.md', files: { 'agent-memory/bin.md': Buffer.from([0xff, 0xfe]) }, reason: 'not UTF-8' },
    { file: 'agent-memory', files: { 'agent-memory': 'x' }, reason: 'not a directory' },
    {
      file: 'agent-memory/sub.md',
      files: { 'agent-memory/sub.md/a': 'x' },
      reason: 'not a regular file',
    },
    { file: 'product', files: { product: 'bad name!' }, reason: "invalid product name 'bad name!'" },
    { file: 'product', files: { product: '  \n' }, reason: "invalid product name ''" },
    { file: 'product', files: { 'product/a': 'x' }, reason: 'not a regular file' },
    { file: 'product', files: { product: Buffer.from([0xc3, 0x28]) }, reason: 'not UTF-8' },
    { file: 'tests', files: { tests: 'x' }, reason: 'not a directory' },
    {
      file: 'tests/sub/link.py',
      files: { 'tests/sub/test_a.py': 'def test_a(): pass\n', 'target.py': 'x' },
      link: { at: 'tests/sub/link.py', to: 'target.py' },
      reason: 'not a regular file or directory',
    },
  ])('invalid external inputs name source and file: $file ($reason)', ({ file, files, link, reason }) => {
    const dir = projectDir(files, link);

    expect(() => validateProjectInputs({ FACTORY_PROJECT_CONFIG_DIR: dir })).toThrow(
      `Invalid FACTORY_PROJECT_CONFIG_DIR (${join(dir, file)}): `,
    );
    expect(() => validateProjectInputs({ FACTORY_PROJECT_CONFIG_DIR: dir })).toThrow(reason);
  });

  it.each([
    { label: '--project-config', env: { FACTORY_PROJECT_CONFIG_DIR_SOURCE: '--project-config' } },
    { label: 'FACTORY_PROJECT_CONFIG_DIR', env: {} },
  ])('invalid external inputs name source and file: labels $label', ({ label, env }) => {
    const dir = projectDir({ product: '_hidden' });

    expect(() => validateProjectInputs({ ...env, FACTORY_PROJECT_CONFIG_DIR: dir })).toThrow(
      `Invalid ${label} (${join(dir, 'product')})`,
    );
  });

  it.each([
    { name: 'no external source', env: () => ({}) },
    { name: 'blank external source', env: () => ({ FACTORY_PROJECT_CONFIG_DIR: ' ' }) },
    { name: 'external without inputs', env: () => ({ FACTORY_PROJECT_CONFIG_DIR: projectDir({}) }) },
    {
      name: 'valid external inputs',
      env: () => ({
        FACTORY_PROJECT_CONFIG_DIR: projectDir({
          'agent-memory/core.md': 'Use the core lane notes.',
          'agent-memory/empty.md': '',
          product: 'web-app\n',
          'tests/test_a.py': 'def test_a(): pass\n',
          'tests/pkg/test_b.py': 'def test_b(): pass\n',
        }),
      }),
    },
  ])('accepts $name', ({ env }) => {
    expect(validateProjectInputs(env())).toBeUndefined();
  });
});
