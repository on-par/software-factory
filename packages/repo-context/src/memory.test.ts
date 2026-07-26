import { describe, expect, it, vi } from 'vitest';

import { createInMemoryReader } from './memory.js';

const FIXTURE = {
  'README.md': 'root readme',
  'docs/adr/README.md': 'adr readme',
  'docs/adr/0001-x.md': 'adr one',
  'src/index.ts': 'export {};',
};

describe('createInMemoryReader construction', () => {
  it('normalizes keys and skips unusable ones', async () => {
    const reader = createInMemoryReader({
      './README.md': 'hello',
      '../escape': 'nope',
      '': 'root, dropped',
    });
    expect(await reader.readFile('README.md')).toEqual({ path: 'README.md', text: 'hello', size: 5 });
    expect(await reader.exists('../escape')).toBe(false);
  });
});

describe('createInMemoryReader readFile', () => {
  const reader = createInMemoryReader(FIXTURE);

  it('reads an existing file', async () => {
    expect(await reader.readFile('docs/adr/0001-x.md')).toEqual({
      path: 'docs/adr/0001-x.md',
      text: 'adr one',
      size: 7,
    });
  });

  it('returns undefined for a missing file', async () => {
    expect(await reader.readFile('nope.md')).toBeUndefined();
  });

  it('degrades wrong-type when the path is a directory', async () => {
    const onDegrade = vi.fn();
    const withObserver = createInMemoryReader(FIXTURE, { onDegrade });
    expect(await withObserver.readFile('docs/adr')).toBeUndefined();
    expect(onDegrade).toHaveBeenCalledWith({ operation: 'readFile', path: 'docs/adr', reason: 'wrong-type' });
  });

  it('degrades invalid-path for an escaping path', async () => {
    const onDegrade = vi.fn();
    const withObserver = createInMemoryReader(FIXTURE, { onDegrade });
    expect(await withObserver.readFile('../escape')).toBeUndefined();
    expect(onDegrade).toHaveBeenCalledWith({ operation: 'readFile', path: '../escape', reason: 'invalid-path' });
  });
});

describe('createInMemoryReader readDir', () => {
  const reader = createInMemoryReader(FIXTURE);

  it('lists the root sorted by path', async () => {
    expect(await reader.readDir('')).toEqual([
      { name: 'README.md', path: 'README.md', type: 'file' },
      { name: 'docs', path: 'docs', type: 'dir' },
      { name: 'src', path: 'src', type: 'dir' },
    ]);
  });

  it('lists a nested prefix', async () => {
    expect(await reader.readDir('docs/adr')).toEqual([
      { name: '0001-x.md', path: 'docs/adr/0001-x.md', type: 'file' },
      { name: 'README.md', path: 'docs/adr/README.md', type: 'file' },
    ]);
  });

  it('dedupes a child seen as both a file and a directory prefix, preferring dir', async () => {
    const collision = createInMemoryReader({ 'dir/x': 'a file at dir/x', 'dir/x/y': 'a nested file' });
    expect(await collision.readDir('dir')).toEqual([{ name: 'x', path: 'dir/x', type: 'dir' }]);
  });

  it('degrades wrong-type when the path is a file', async () => {
    const onDegrade = vi.fn();
    const withObserver = createInMemoryReader(FIXTURE, { onDegrade });
    expect(await withObserver.readDir('README.md')).toEqual([]);
    expect(onDegrade).toHaveBeenCalledWith({ operation: 'readDir', path: 'README.md', reason: 'wrong-type' });
  });

  it('degrades not-found for an unknown prefix', async () => {
    const onDegrade = vi.fn();
    const withObserver = createInMemoryReader(FIXTURE, { onDegrade });
    expect(await withObserver.readDir('nope')).toEqual([]);
    expect(onDegrade).toHaveBeenCalledWith({ operation: 'readDir', path: 'nope', reason: 'not-found' });
  });

  it('degrades invalid-path for an escaping path', async () => {
    const onDegrade = vi.fn();
    const withObserver = createInMemoryReader(FIXTURE, { onDegrade });
    expect(await withObserver.readDir('../escape')).toEqual([]);
    expect(onDegrade).toHaveBeenCalledWith({ operation: 'readDir', path: '../escape', reason: 'invalid-path' });
  });

  it('lists an empty tree root with no event', async () => {
    const onDegrade = vi.fn();
    const empty = createInMemoryReader({}, { onDegrade });
    expect(await empty.readDir('')).toEqual([]);
    expect(onDegrade).not.toHaveBeenCalled();
  });
});

describe('createInMemoryReader exists', () => {
  const reader = createInMemoryReader(FIXTURE);

  it('is true for the root', async () => {
    expect(await reader.exists('')).toBe(true);
  });

  it('is true for an exact file', async () => {
    expect(await reader.exists('README.md')).toBe(true);
  });

  it('is true for a directory prefix', async () => {
    expect(await reader.exists('docs/adr')).toBe(true);
  });

  it('is false for a miss', async () => {
    expect(await reader.exists('nope')).toBe(false);
  });

  it('degrades invalid-path for an escaping path', async () => {
    const onDegrade = vi.fn();
    const withObserver = createInMemoryReader(FIXTURE, { onDegrade });
    expect(await withObserver.exists('../escape')).toBe(false);
    expect(onDegrade).toHaveBeenCalledWith({ operation: 'exists', path: '../escape', reason: 'invalid-path' });
  });
});

describe('createInMemoryReader robustness', () => {
  it('does not reject when onDegrade throws', async () => {
    const reader = createInMemoryReader(FIXTURE, {
      onDegrade: () => {
        throw new Error('observer exploded');
      },
    });
    await expect(reader.readFile('nope.md')).resolves.toBeUndefined();
  });
});
