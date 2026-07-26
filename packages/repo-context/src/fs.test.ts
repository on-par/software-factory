// src/fs.test.ts — degrade-path tests for createFsReader (#481).
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { FsDirent, FsLike, FsStatLike } from './fs.js';
import { createFsReader } from './fs.js';
import type { DegradeEvent } from './reader.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'repo-context-fs-test-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function collectDegrades(): { events: DegradeEvent[]; onDegrade: (event: DegradeEvent) => void } {
  const events: DegradeEvent[] = [];
  return { events, onDegrade: (event) => events.push(event) };
}

describe('createFsReader degrade paths', () => {
  it('readFile of a path escaping the root via ../ degrades to invalid-path', async () => {
    await writeFile(join(root, 'inside.md'), 'inside');
    const outsideDir = await mkdtemp(join(tmpdir(), 'repo-context-fs-outside-'));
    await writeFile(join(outsideDir, 'outside.md'), 'outside');
    const { events, onDegrade } = collectDegrades();
    const reader = createFsReader({ root, onDegrade });

    expect(await reader.readFile('../outside.md')).toBeUndefined();
    expect(events).toEqual([{ operation: 'readFile', path: '../outside.md', reason: 'invalid-path' }]);

    await rm(outsideDir, { recursive: true, force: true });
  });

  it('a symlink inside the root pointing outside it degrades to invalid-path', async () => {
    const outsideDir = await mkdtemp(join(tmpdir(), 'repo-context-fs-outside-'));
    await writeFile(join(outsideDir, 'secret.md'), 'secret');
    await symlink(join(outsideDir, 'secret.md'), join(root, 'escape.md'));
    const { events, onDegrade } = collectDegrades();
    const reader = createFsReader({ root, onDegrade });

    expect(await reader.readFile('escape.md')).toBeUndefined();
    expect(events).toEqual([{ operation: 'readFile', path: 'escape.md', reason: 'invalid-path' }]);

    await rm(outsideDir, { recursive: true, force: true });
  });

  it('a file larger than maxFileBytes degrades to too-large', async () => {
    await writeFile(join(root, 'big.md'), '0123456789');
    const { events, onDegrade } = collectDegrades();
    const reader = createFsReader({ root, maxFileBytes: 4, onDegrade });

    expect(await reader.readFile('big.md')).toBeUndefined();
    expect(events).toEqual([{ operation: 'readFile', path: 'big.md', reason: 'too-large' }]);
  });

  it('a file containing a NUL byte degrades to unsupported-content', async () => {
    await writeFile(join(root, 'binary.md'), Buffer.from('abc\u0000def'));
    const { events, onDegrade } = collectDegrades();
    const reader = createFsReader({ root, onDegrade });

    expect(await reader.readFile('binary.md')).toBeUndefined();
    expect(events).toEqual([{ operation: 'readFile', path: 'binary.md', reason: 'unsupported-content' }]);
  });

  it('classifies an injected EACCES error as unauthorized', async () => {
    const fs: FsLike = {
      stat: () => Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' })),
      readdir: () => Promise.reject(new Error('unused')),
      readFile: () => Promise.reject(new Error('unused')),
      realpath: (p) => Promise.resolve(p),
    };
    const { events, onDegrade } = collectDegrades();
    const reader = createFsReader({ root, fs, onDegrade });

    expect(await reader.readFile('anything.md')).toBeUndefined();
    expect(events).toEqual([{ operation: 'readFile', path: 'anything.md', reason: 'unauthorized' }]);
  });

  it('classifies an injected ELOOP error as invalid-path', async () => {
    const fs: FsLike = {
      stat: () => Promise.reject(Object.assign(new Error('loop'), { code: 'ELOOP' })),
      readdir: () => Promise.reject(new Error('unused')),
      readFile: () => Promise.reject(new Error('unused')),
      realpath: (p) => Promise.resolve(p),
    };
    const { events, onDegrade } = collectDegrades();
    const reader = createFsReader({ root, fs, onDegrade });

    expect(await reader.readFile('anything.md')).toBeUndefined();
    expect(events).toEqual([{ operation: 'readFile', path: 'anything.md', reason: 'invalid-path' }]);
  });

  it('classifies an injected bare Error as invalid-response', async () => {
    const fs: FsLike = {
      stat: () => Promise.reject(new Error('boom')),
      readdir: () => Promise.reject(new Error('unused')),
      readFile: () => Promise.reject(new Error('unused')),
      realpath: (p) => Promise.resolve(p),
    };
    const { events, onDegrade } = collectDegrades();
    const reader = createFsReader({ root, fs, onDegrade });

    expect(await reader.readFile('anything.md')).toBeUndefined();
    expect(events).toEqual([{ operation: 'readFile', path: 'anything.md', reason: 'invalid-response' }]);
  });

  it('exists on a missing path is false with no degrade event', async () => {
    const { events, onDegrade } = collectDegrades();
    const reader = createFsReader({ root, onDegrade });

    expect(await reader.exists('nope.md')).toBe(false);
    expect(events).toEqual([]);
  });

  it('exists on an EACCES path is false with a degrade event', async () => {
    const fs: FsLike = {
      stat: () => Promise.reject(new Error('unused')),
      readdir: () => Promise.reject(new Error('unused')),
      readFile: () => Promise.reject(new Error('unused')),
      realpath: () => Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' })),
    };
    const { events, onDegrade } = collectDegrades();
    const reader = createFsReader({ root, fs, onDegrade });

    expect(await reader.exists('anything.md')).toBe(false);
    expect(events).toEqual([{ operation: 'exists', path: 'anything.md', reason: 'unauthorized' }]);
  });

  it('a throwing onDegrade observer does not make readFile throw', async () => {
    const reader = createFsReader({
      root,
      onDegrade: () => {
        throw new Error('observer boom');
      },
    });

    await expect(reader.readFile('nope.md')).resolves.toBeUndefined();
  });

  it('readDir on a directory containing a symlink to a file lists it as type file', async () => {
    await mkdir(join(root, 'dir'));
    await writeFile(join(root, 'dir', 'real.md'), 'real');
    await symlink(join(root, 'dir', 'real.md'), join(root, 'dir', 'link.md'));

    const reader = createFsReader({ root });
    const entries = await reader.readDir('dir');

    expect(entries).toEqual([
      { name: 'link.md', path: 'dir/link.md', type: 'file' },
      { name: 'real.md', path: 'dir/real.md', type: 'file' },
    ]);
  });

  it('degrades to not-found when the root itself cannot be realpath-ed', async () => {
    const fs: FsLike = {
      stat: () => Promise.reject(new Error('unused')),
      readdir: () => Promise.reject(new Error('unused')),
      readFile: () => Promise.reject(new Error('unused')),
      realpath: (p) => (p === root ? Promise.reject(new Error('root gone')) : Promise.resolve(p)),
    };
    const { events, onDegrade } = collectDegrades();
    const reader = createFsReader({ root, fs, onDegrade });

    expect(await reader.exists('file.md')).toBe(false);
    expect(events).toEqual([]);
  });

  it('readFile of a special file (neither directory nor regular file) degrades to wrong-type', async () => {
    const specialStat: FsStatLike = { isDirectory: () => false, isFile: () => false, size: 0 };
    const fs: FsLike = {
      stat: () => Promise.resolve(specialStat),
      readdir: () => Promise.reject(new Error('unused')),
      readFile: () => Promise.reject(new Error('unused')),
      realpath: (p) => Promise.resolve(p),
    };
    const { events, onDegrade } = collectDegrades();
    const reader = createFsReader({ root, fs, onDegrade });

    expect(await reader.readFile('device')).toBeUndefined();
    expect(events).toEqual([{ operation: 'readFile', path: 'device', reason: 'wrong-type' }]);
  });

  it('readFile degrades when fs.readFile itself throws', async () => {
    const fileStat: FsStatLike = { isDirectory: () => false, isFile: () => true, size: 1 };
    const fs: FsLike = {
      stat: () => Promise.resolve(fileStat),
      readdir: () => Promise.reject(new Error('unused')),
      readFile: () => Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' })),
      realpath: (p) => Promise.resolve(p),
    };
    const { events, onDegrade } = collectDegrades();
    const reader = createFsReader({ root, fs, onDegrade });

    expect(await reader.readFile('file.md')).toBeUndefined();
    expect(events).toEqual([{ operation: 'readFile', path: 'file.md', reason: 'unauthorized' }]);
  });

  it('readDir of a path escaping the root via ../ degrades to invalid-path', async () => {
    const { events, onDegrade } = collectDegrades();
    const reader = createFsReader({ root, onDegrade });

    expect(await reader.readDir('../outside')).toEqual([]);
    expect(events).toEqual([{ operation: 'readDir', path: '../outside', reason: 'invalid-path' }]);
  });

  it('readDir of a missing directory degrades to not-found and returns empty', async () => {
    const { events, onDegrade } = collectDegrades();
    const reader = createFsReader({ root, onDegrade });

    expect(await reader.readDir('nope')).toEqual([]);
    expect(events).toEqual([{ operation: 'readDir', path: 'nope', reason: 'not-found' }]);
  });

  it('readDir degrades when fs.stat throws after resolving', async () => {
    const fs: FsLike = {
      stat: () => Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' })),
      readdir: () => Promise.reject(new Error('unused')),
      readFile: () => Promise.reject(new Error('unused')),
      realpath: (p) => Promise.resolve(p),
    };
    const { events, onDegrade } = collectDegrades();
    const reader = createFsReader({ root, fs, onDegrade });

    expect(await reader.readDir('dir')).toEqual([]);
    expect(events).toEqual([{ operation: 'readDir', path: 'dir', reason: 'unauthorized' }]);
  });

  it('readDir degrades when fs.readdir itself throws', async () => {
    const dirStat: FsStatLike = { isDirectory: () => true, isFile: () => false, size: 0 };
    const fs: FsLike = {
      stat: () => Promise.resolve(dirStat),
      readdir: () => Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' })),
      readFile: () => Promise.reject(new Error('unused')),
      realpath: (p) => Promise.resolve(p),
    };
    const { events, onDegrade } = collectDegrades();
    const reader = createFsReader({ root, fs, onDegrade });

    expect(await reader.readDir('')).toEqual([]);
    expect(events).toEqual([{ operation: 'readDir', path: '', reason: 'unauthorized' }]);
  });

  it('exists on a path escaping the root via ../ degrades to invalid-path', async () => {
    const { events, onDegrade } = collectDegrades();
    const reader = createFsReader({ root, onDegrade });

    expect(await reader.exists('../outside.md')).toBe(false);
    expect(events).toEqual([{ operation: 'exists', path: '../outside.md', reason: 'invalid-path' }]);
  });

  it('readDir on a directory containing a symlink to a directory lists it as type dir', async () => {
    await mkdir(join(root, 'dir'));
    await mkdir(join(root, 'target'));
    await symlink(join(root, 'target'), join(root, 'dir', 'link-dir'));

    const reader = createFsReader({ root });
    const entries = await reader.readDir('dir');

    expect(entries).toEqual([{ name: 'link-dir', path: 'dir/link-dir', type: 'dir' }]);
  });

  it('readDir skips a dirent whose fallback stat throws', async () => {
    const brokenDirent: FsDirent = {
      name: 'broken',
      isDirectory: () => false,
      isFile: () => false,
    };
    const dirStat: FsStatLike = { isDirectory: () => true, isFile: () => false, size: 0 };
    const fs: FsLike = {
      stat: (p) => (p === root ? Promise.resolve(dirStat) : Promise.reject(new Error('gone'))),
      readdir: () => Promise.resolve([brokenDirent]),
      readFile: () => Promise.reject(new Error('unused')),
      realpath: (p) => Promise.resolve(p),
    };
    const reader = createFsReader({ root, fs });

    expect(await reader.readDir('')).toEqual([]);
  });
});
