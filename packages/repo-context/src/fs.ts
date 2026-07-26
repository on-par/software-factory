// src/fs.ts — local-filesystem RepoContextReader impl over a checkout root (#481).
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';

import { DEFAULT_MAX_FILE_BYTES } from './github.js';
import { joinRepoPath, normalizeRepoPath } from './path.js';
import type { DegradeEvent, DegradeReason, OnDegrade, RepoContextReader, RepoDirEntry } from './reader.js';
import { EMPTY_DIR } from './reader.js';

/** Minimal `node:fs/promises` surface the reader needs; injected in tests. */
export interface FsDirent {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

export interface FsStatLike {
  isDirectory(): boolean;
  isFile(): boolean;
  size: number;
}

export interface FsLike {
  stat(path: string): Promise<FsStatLike>;
  readdir(path: string, options: { withFileTypes: true }): Promise<readonly FsDirent[]>;
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  realpath(path: string): Promise<string>;
}

export interface FsReaderOptions {
  /** Absolute path to the checkout root; every read is confined to it. */
  root: string;
  /** Files larger than this degrade to `too-large`. Defaults to DEFAULT_MAX_FILE_BYTES. */
  maxFileBytes?: number;
  /** Injected for tests; defaults to node:fs/promises. */
  fs?: FsLike;
  onDegrade?: OnDegrade;
}

const nodeFs: FsLike = {
  stat: (p) => stat(p),
  readdir: (p, o) => readdir(p, o),
  readFile: (p, e) => readFile(p, e),
  realpath: (p) => realpath(p),
};

function classifyFsError(error: unknown): DegradeReason {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  switch (code) {
    case 'ENOENT':
    case 'ENOTDIR':
      return 'not-found';
    case 'EACCES':
    case 'EPERM':
      return 'unauthorized';
    case 'ELOOP':
    case 'ENAMETOOLONG':
      return 'invalid-path';
    default:
      return 'invalid-response';
  }
}

export function createFsReader(options: FsReaderOptions): RepoContextReader {
  const { root, onDegrade } = options;
  const fs = options.fs ?? nodeFs;
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;

  let rootRealPromise: Promise<string | undefined> | undefined;
  function rootReal(): Promise<string | undefined> {
    rootRealPromise ??= fs.realpath(root).catch(() => undefined);
    return rootRealPromise;
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

  type ResolveResult = { ok: true; abs: string } | { ok: false; reason: DegradeReason };

  async function resolveWithin(normalized: string): Promise<ResolveResult> {
    const abs = normalized === '' ? root : join(root, normalized);
    let real: string;
    try {
      real = await fs.realpath(abs);
    } catch (error) {
      return { ok: false, reason: classifyFsError(error) };
    }
    const base = await rootReal();
    if (base === undefined) {
      return { ok: false, reason: 'not-found' };
    }
    if (real !== base && !real.startsWith(base + sep)) {
      return { ok: false, reason: 'invalid-path' };
    }
    return { ok: true, abs: real };
  }

  return {
    async readFile(rawPath) {
      const normalized = normalizeRepoPath(rawPath);
      if (normalized === undefined) {
        emit({ operation: 'readFile', path: rawPath, reason: 'invalid-path' });
        return undefined;
      }

      const resolved = await resolveWithin(normalized);
      if (!resolved.ok) {
        emit({ operation: 'readFile', path: normalized, reason: resolved.reason });
        return undefined;
      }

      let fileStat: FsStatLike;
      try {
        fileStat = await fs.stat(resolved.abs);
      } catch (error) {
        emit({ operation: 'readFile', path: normalized, reason: classifyFsError(error) });
        return undefined;
      }

      if (fileStat.isDirectory()) {
        emit({ operation: 'readFile', path: normalized, reason: 'wrong-type' });
        return undefined;
      }
      if (fileStat.size > maxFileBytes) {
        emit({ operation: 'readFile', path: normalized, reason: 'too-large' });
        return undefined;
      }
      if (!fileStat.isFile()) {
        emit({ operation: 'readFile', path: normalized, reason: 'wrong-type' });
        return undefined;
      }

      let text: string;
      try {
        text = await fs.readFile(resolved.abs, 'utf8');
      } catch (error) {
        emit({ operation: 'readFile', path: normalized, reason: classifyFsError(error) });
        return undefined;
      }

      if (text.includes('\u0000')) {
        emit({ operation: 'readFile', path: normalized, reason: 'unsupported-content' });
        return undefined;
      }

      return { path: normalized, text, size: fileStat.size };
    },

    async readDir(rawPath) {
      const normalized = normalizeRepoPath(rawPath);
      if (normalized === undefined) {
        emit({ operation: 'readDir', path: rawPath, reason: 'invalid-path' });
        return EMPTY_DIR;
      }

      const resolved = await resolveWithin(normalized);
      if (!resolved.ok) {
        emit({ operation: 'readDir', path: normalized, reason: resolved.reason });
        return EMPTY_DIR;
      }

      let dirStat: FsStatLike;
      try {
        dirStat = await fs.stat(resolved.abs);
      } catch (error) {
        emit({ operation: 'readDir', path: normalized, reason: classifyFsError(error) });
        return EMPTY_DIR;
      }

      if (!dirStat.isDirectory()) {
        emit({ operation: 'readDir', path: normalized, reason: 'wrong-type' });
        return EMPTY_DIR;
      }

      let dirents: readonly FsDirent[];
      try {
        dirents = await fs.readdir(resolved.abs, { withFileTypes: true });
      } catch (error) {
        emit({ operation: 'readDir', path: normalized, reason: classifyFsError(error) });
        return EMPTY_DIR;
      }

      const entries: RepoDirEntry[] = [];
      for (const dirent of dirents) {
        const childPath = joinRepoPath(normalized, dirent.name);
        if (dirent.isDirectory()) {
          entries.push({ name: dirent.name, path: childPath, type: 'dir' });
          continue;
        }
        if (dirent.isFile()) {
          entries.push({ name: dirent.name, path: childPath, type: 'file' });
          continue;
        }
        // Symlink or other special file: resolve via stat, skip on failure.
        try {
          const childStat = await fs.stat(join(resolved.abs, dirent.name));
          entries.push({ name: dirent.name, path: childPath, type: childStat.isDirectory() ? 'dir' : 'file' });
        } catch {
          continue;
        }
      }

      return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    },

    async exists(rawPath) {
      const normalized = normalizeRepoPath(rawPath);
      if (normalized === undefined) {
        emit({ operation: 'exists', path: rawPath, reason: 'invalid-path' });
        return false;
      }

      const resolved = await resolveWithin(normalized);
      if (!resolved.ok) {
        if (resolved.reason === 'not-found') {
          return false;
        }
        emit({ operation: 'exists', path: normalized, reason: resolved.reason });
        return false;
      }

      return true;
    },
  };
}
