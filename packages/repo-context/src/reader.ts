// src/reader.ts — the read-only repo access port every backend implements (#468).

/** A file read from the target repo. `path` is the normalized, repo-root-relative path. */
export interface RepoFile {
  path: string;
  /** UTF-8 decoded contents. */
  text: string;
  /** Byte length reported by the backend. */
  size: number;
}

export type RepoEntryType = 'file' | 'dir';

export interface RepoDirEntry {
  /** Basename, e.g. 'README.md'. */
  name: string;
  /** Repo-root-relative path, e.g. 'docs/adr/README.md'. */
  path: string;
  type: RepoEntryType;
}

/**
 * Read-only access to one repository at one revision.
 *
 * Backend coordinates (owner/repo/ref/token/worktree root) are bound when the reader is
 * constructed, never passed here — that is what lets a gh-contents reader, an fs-backed
 * reader, and a future blobless sparse-checkout reader be swapped without changing callers.
 *
 * No method throws. A path that is missing, unreadable, unauthorized, rate-limited, too
 * large, or not text degrades to the empty result for that method; pass `onDegrade` to the
 * factory to observe why.
 */
export interface RepoContextReader {
  readFile(path: string): Promise<RepoFile | undefined>;
  readDir(path: string): Promise<readonly RepoDirEntry[]>;
  exists(path: string): Promise<boolean>;
}

export type RepoContextOperation = 'readFile' | 'readDir' | 'exists';

export type DegradeReason =
  | 'invalid-path'
  | 'not-found'
  | 'wrong-type'
  | 'unauthorized'
  | 'rate-limited'
  | 'too-large'
  | 'unsupported-content'
  | 'network'
  | 'invalid-response';

export interface DegradeEvent {
  operation: RepoContextOperation;
  /** The requested path, normalized when normalization succeeded. */
  path: string;
  reason: DegradeReason;
  /** HTTP status, when the backend is remote. */
  status?: number;
  detail?: string;
}

export type OnDegrade = (event: DegradeEvent) => void;

/** The empty listing every backend degrades to, so callers can compare identity if useful. */
export const EMPTY_DIR: readonly RepoDirEntry[] = Object.freeze([]);
