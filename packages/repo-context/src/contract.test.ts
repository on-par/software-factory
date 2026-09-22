import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createFsReader } from './fs.js';
import { createInMemoryReader } from './memory.js';
import type { RepoContextReader } from './reader.js';

const TREE: Readonly<Record<string, string>> = {
  'README.md': 'root readme',
  'docs/adr/README.md': 'adr readme',
  'docs/adr/0001-x.md': 'adr one',
  'src/index.ts': 'export {};',
};

function makeMemoryReader(): RepoContextReader {
  return createInMemoryReader(TREE);
}

let fsRoot: string;

function makeFsReader(): RepoContextReader {
  return createFsReader({ root: fsRoot });
}

beforeAll(async () => {
  fsRoot = await mkdtemp(join(tmpdir(), 'repo-context-fs-'));
  for (const [path, contents] of Object.entries(TREE)) {
    const abs = join(fsRoot, path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, contents);
  }
});

afterAll(async () => {
  await rm(fsRoot, { recursive: true, force: true });
});

describe.each([
  ['in-memory', makeMemoryReader],
  ['fs', makeFsReader],
])('%s reader honors the RepoContextReader contract', (_label, makeReader) => {
  it('reads a nested file', async () => {
    const reader = makeReader();
    expect(await reader.readFile('docs/adr/0001-x.md')).toEqual({
      path: 'docs/adr/0001-x.md',
      text: 'adr one',
      size: 7,
    });
  });

  it('lists the root', async () => {
    const reader = makeReader();
    expect(await reader.readDir('')).toEqual([
      { name: 'README.md', path: 'README.md', type: 'file' },
      { name: 'docs', path: 'docs', type: 'dir' },
      { name: 'src', path: 'src', type: 'dir' },
    ]);
  });

  it('lists a nested directory', async () => {
    const reader = makeReader();
    expect(await reader.readDir('docs/adr')).toEqual([
      { name: '0001-x.md', path: 'docs/adr/0001-x.md', type: 'file' },
      { name: 'README.md', path: 'docs/adr/README.md', type: 'file' },
    ]);
  });

  it('exists is true for a file', async () => {
    const reader = makeReader();
    expect(await reader.exists('README.md')).toBe(true);
  });

  it('exists is true for a directory', async () => {
    const reader = makeReader();
    expect(await reader.exists('docs/adr')).toBe(true);
  });

  it('exists is false for a missing path', async () => {
    const reader = makeReader();
    expect(await reader.exists('nope')).toBe(false);
  });

  it('readFile of a missing path is undefined', async () => {
    const reader = makeReader();
    expect(await reader.readFile('nope.md')).toBeUndefined();
  });

  it('readFile of a directory is undefined', async () => {
    const reader = makeReader();
    expect(await reader.readFile('docs/adr')).toBeUndefined();
  });

  it('readDir of a file is empty', async () => {
    const reader = makeReader();
    expect(await reader.readDir('README.md')).toEqual([]);
  });
});
