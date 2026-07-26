// src/memory.ts — in-memory RepoContextReader over a flat path -> contents map (#468).

import { Buffer } from 'node:buffer';

import { normalizeRepoPath } from './path.js';
import type { DegradeEvent, OnDegrade, RepoContextReader, RepoDirEntry } from './reader.js';
import { EMPTY_DIR } from './reader.js';

export interface InMemoryReaderOptions {
  onDegrade?: OnDegrade;
}

/** In-memory `RepoContextReader` over a flat `path -> contents` map. */
export function createInMemoryReader(
  files: Readonly<Record<string, string>>,
  options?: InMemoryReaderOptions,
): RepoContextReader {
  const onDegrade = options?.onDegrade;
  const store = new Map<string, string>();
  for (const [rawPath, contents] of Object.entries(files)) {
    const normalized = normalizeRepoPath(rawPath);
    if (normalized === undefined || normalized === '') {
      continue;
    }
    store.set(normalized, contents);
  }

  function emit(event: DegradeEvent): void {
    if (!onDegrade) {
      return;
    }
    try {
      onDegrade(event);
    } catch {
      // Never let a throwing observer break the "never throws" contract.
    }
  }

  function isDirPrefix(path: string): boolean {
    const prefix = `${path}/`;
    for (const key of store.keys()) {
      if (key.startsWith(prefix)) {
        return true;
      }
    }
    return false;
  }

  return {
    async readFile(rawPath) {
      const normalized = normalizeRepoPath(rawPath);
      if (normalized === undefined) {
        emit({ operation: 'readFile', path: rawPath, reason: 'invalid-path' });
        return undefined;
      }
      const text = store.get(normalized);
      if (text !== undefined) {
        return { path: normalized, text, size: Buffer.byteLength(text, 'utf8') };
      }
      if (isDirPrefix(normalized)) {
        emit({ operation: 'readFile', path: normalized, reason: 'wrong-type' });
        return undefined;
      }
      emit({ operation: 'readFile', path: normalized, reason: 'not-found' });
      return undefined;
    },

    async readDir(rawPath) {
      const normalized = normalizeRepoPath(rawPath);
      if (normalized === undefined) {
        emit({ operation: 'readDir', path: rawPath, reason: 'invalid-path' });
        return EMPTY_DIR;
      }
      if (store.has(normalized)) {
        emit({ operation: 'readDir', path: normalized, reason: 'wrong-type' });
        return EMPTY_DIR;
      }

      const prefix = normalized === '' ? '' : `${normalized}/`;
      const children = new Map<string, RepoDirEntry>();
      for (const key of store.keys()) {
        if (!key.startsWith(prefix)) {
          continue;
        }
        const rest = key.slice(prefix.length);
        const segments = rest.split('/');
        const name = segments[0]!;
        const childPath = prefix === '' ? name : `${prefix}${name}`;
        const type = segments.length === 1 ? 'file' : 'dir';
        const existing = children.get(childPath);
        if (!existing || (existing.type === 'file' && type === 'dir')) {
          children.set(childPath, { name, path: childPath, type });
        }
      }

      if (children.size === 0 && normalized !== '') {
        emit({ operation: 'readDir', path: normalized, reason: 'not-found' });
        return EMPTY_DIR;
      }

      return [...children.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    },

    async exists(rawPath) {
      const normalized = normalizeRepoPath(rawPath);
      if (normalized === undefined) {
        emit({ operation: 'exists', path: rawPath, reason: 'invalid-path' });
        return false;
      }
      if (normalized === '' || store.has(normalized) || isDirPrefix(normalized)) {
        return true;
      }
      return false;
    },
  };
}
